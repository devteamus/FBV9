/**
 * POST /api/jobs/[id]/resume — resume a paused job
 * Re-enqueues pending posts into BullMQ with computed delays.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, AuthError } from "@/lib/auth";
import { requireJobOwned } from "@/lib/ownership";
import { enqueueJobPosts } from "@/lib/queues/helpers";
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
    if (job.status !== "paused") {
      return NextResponse.json(
        { error: "Job is not paused" },
        { status: 400 }
      );
    }

    // Get pending posts and re-enqueue them
    const pendingPosts = await prisma.post.findMany({
      where: {
        jobId: id,
        status: "pending",
      },
      include: {
        account: { select: { fbPageId: true } },
      },
      // Order by csvRowIndex — preserves CSV upload order on resume.
      // (Previously `createdAt asc` which was non-deterministic because
      // `createMany` writes all rows with the same timestamp.)
      orderBy: { csvRowIndex: "asc" },
    });

    if (pendingPosts.length > 0) {
      const redis = getRedis();

      // Calculate start time: now, or after the last posted post
      const lastPosted = await prisma.post.findFirst({
        where: { jobId: id, status: "posted", postedAt: { not: null } },
        orderBy: { postedAt: "desc" },
      });
      const startAt = lastPosted?.postedAt ?? new Date();

      await enqueueJobPosts(
        redis,
        pendingPosts.map((p, index) => ({
          id: p.id,
          jobId: p.jobId,
          accountId: p.accountId,
          pageId: p.account.fbPageId,
          postType: p.postType,
          index,
          intervalMinutes: job.intervalMinutes,
          startAt,
        }))
      );

      // Mark enqueued posts as scheduled
      const now = new Date();
      for (let i = 0; i < pendingPosts.length; i++) {
        const scheduledAt = new Date(
          startAt.getTime() + i * job.intervalMinutes * 60_000
        );
        await prisma.post.update({
          where: { id: pendingPosts[i].id },
          data: {
            status: "scheduled",
            scheduledAt: scheduledAt > now ? scheduledAt : now,
            bullJobId: pendingPosts[i].id,
          },
        });
      }
    }

    await prisma.job.update({
      where: { id },
      data: { status: "running" },
    });

    return NextResponse.json({ success: true, status: "running" });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[jobs:resume]", err);
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
