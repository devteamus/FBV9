/**
 * GET    /api/jobs/[id] — get single job detail
 * DELETE /api/jobs/[id] — delete job (cancel BullMQ jobs, cascade delete)
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, AuthError } from "@/lib/auth";
import { requireJob, serializeJob } from "@/lib/ownership";
import { cancelJobPostsByIds } from "@/lib/queues/helpers";
import { getRedis } from "@/lib/redis";
import { prisma } from "@/lib/prisma";
import fs from "node:fs";
import path from "node:path";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { sub: userId } = await getSession();
    const { id } = await params;
    const job = await requireJob(userId, id);
    return NextResponse.json(serializeJob(job));
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { sub: userId } = await getSession();
    const { id } = await params;

    // Ownership check
    const job = await requireJob(userId, id);

    // v2.2: bounded, scan-free cancel of this job's live queue entries
    // (the old whole-queue getJobs scan was an OOM risk at scale).
    const redis = getRedis();
    const livePosts = await prisma.post.findMany({
      where: {
        jobId: id,
        status: { in: ["pending", "scheduled", "posting", "paused"] },
      },
      select: { id: true, postType: true, scheduledAt: true },
    });
    await cancelJobPostsByIds(
      redis,
      livePosts.map((p) => ({
        id: p.id,
        postType: p.postType,
        scheduledAt: p.scheduledAt,
      }))
    );

    // Delete CSV file if it exists
    const filepath = path.join("/app/uploads", job.filename);
    if (fs.existsSync(filepath)) {
      try {
        fs.unlinkSync(filepath);
      } catch {
        // best effort
      }
    }

    // Delete job (Prisma cascades to posts)
    await prisma.job.delete({ where: { id } });

    return NextResponse.json({ success: true });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[jobs:delete]", err);
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
