/**
 * POST /api/jobs/[id]/pause — pause a running job
 *
 * v2.2:
 * - Bounded cancel: only THIS job's non-terminal posts are probed by direct
 *   id lookups (cancelJobPostsByIds). The old whole-queue scan
 *   (`getJobs` over every waiting/delayed/active job in Redis) was an
 *   OOM risk at tens of thousands of delayed jobs.
 * - Paused posts now get the status "paused" (previously "pending").
 *   The atomic guard in processPostJob only accepts pending/scheduled —
 *   so any queue entry that slips past the cancel (e.g. a rate-limit
 *   retry job created moments before the pause) is rejected when it
 *   fires, and a paused job can never leak a post to Facebook.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, AuthError } from "@/lib/auth";
import { requireJobOwned } from "@/lib/ownership";
import { cancelJobPostsByIds } from "@/lib/queues/helpers";
import { getRedis } from "@/lib/redis";
import { prisma } from "@/lib/prisma";
import { pauseComments } from "@/lib/comment-pause";

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

    const redis = getRedis();

    // This job's not-yet-published posts (bounded by the job's own row
    // count) — used for the direct-id cancel below.
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

    // Move every not-yet-published post to "paused" so a later resume
    // re-enqueues them. "posting" rows included: if a post is mid-flight
    // in a worker at this instant, the worker's own completion write
    // (posted/failed) still wins afterwards — which is correct, because
    // it really did reach Facebook.
    await prisma.post.updateMany({
      where: {
        jobId: id,
        status: { in: ["pending", "scheduled", "posting", "paused"] },
      },
      data: { status: "paused", bullJobId: null },
    });

    await prisma.job.update({
      where: { id },
      data: { status: "paused" },
    });

    // v2.4 — comments pause together with the posts: pending comments of
    // this job's posts are parked ("paused") and their delayed jobs removed.
    try {
      await pauseComments(redis, { post: { jobId: id } });
    } catch (commentErr) {
      console.error("[jobs:pause] could not pause comments", commentErr);
    }

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
