/**
 * POST /api/jobs/[id]/pause — pause a running job
 * Cancels pending BullMQ jobs but keeps DB records.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, AuthError } from "@/lib/auth";
import { requireJobOwned } from "@/lib/ownership";
import { cancelJobPosts } from "@/lib/queues/helpers";
import { getRedis } from "@/lib/redis";
import { prisma } from "@/lib/prisma";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { sub: userId } = await getSession();
    const { id } = await params;

    const job = await requireJobOwned(userId, id);
    if (job.status !== "running") {
      return NextResponse.json(
        { error: "Job is not running" },
        { status: 400 }
      );
    }

    // Cancel pending BullMQ jobs for this job
    const redis = getRedis();
    await cancelJobPosts(redis, id);

    // Reset non-posted posts back to pending (they'll be re-enqueued on resume)
    await prisma.post.updateMany({
      where: {
        jobId: id,
        status: { in: ["scheduled", "posting"] },
      },
      data: { status: "pending", bullJobId: null },
    });

    await prisma.job.update({
      where: { id },
      data: { status: "paused" },
    });

    const updated = await prisma.job.findUniqueOrThrow({ where: { id } });
    return NextResponse.json({ success: true, status: updated.status });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[jobs:pause]", err);
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
