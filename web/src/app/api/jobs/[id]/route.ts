/**
 * GET    /api/jobs/[id] — get single job detail
 * DELETE /api/jobs/[id] — delete job (cancel BullMQ jobs, cascade delete)
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, AuthError } from "@/lib/auth";
import { requireJob, serializeJob } from "@/lib/ownership";
import { cancelJobPosts } from "@/lib/queues/helpers";
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

    // Cancel any pending BullMQ jobs for this job
    const redis = getRedis();
    await cancelJobPosts(redis, id);

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
