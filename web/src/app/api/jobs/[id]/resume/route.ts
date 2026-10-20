/**
 * POST /api/jobs/[id]/resume — resume a paused job
 *
 * v2.2 — interval-preserving anchor rule.
 *
 * The FIRST pending post is scheduled at:
 *   max(lastPublishedAt + interval, now)      — when something was already published
 *   max(original scheduledStartAt, now)       — when nothing was published yet
 *
 * Consequences (this is the pause→resume contract):
 * - Resuming LATE (e.g. paused 8pm, resumed 10pm with a 4h interval and
 *   the last post published at 4pm): the pushed post goes out right at
 *   10pm (resume moment) — but never sooner than one full interval after
 *   the last published post. Every later post continues at +interval
 *   from there (2am, 6am, 10am …).
 * - Resuming EARLY (before the next post was originally due): the
 *   original schedule is preserved — next post still lands exactly
 *   interval after the last published one.
 * - Resuming a job that never published anything: the original
 *   user-selected start time is honored (or "now" for legacy jobs).
 * - A long pause can NEVER dump a burst of overdue posts: every post
 *   after the first is re-anchored past-first + i*interval, all in the
 *   future. (The pre-v2.2 code anchored at lastPostedAt, so posts that
 *   became overdue during the pause all fired at once on resume.)
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

    // Non-terminal posts. "paused" is the normal state here (set by the
    // pause route); "pending"/"scheduled" are defensive includes for rows
    // left behind by edge paths.
    //
    // v2.3 — select instead of include: this query only needs 5 fields
    // per row for the re-enqueue; loading full rows (caption, mediaUrl,
    // comment, …) needlessly materialized megabytes of text for a
    // 5000-post resume.
    const pendingPosts = await prisma.post.findMany({
      where: {
        jobId: id,
        status: { in: ["pending", "paused", "scheduled"] },
      },
      select: {
        id: true,
        jobId: true,
        accountId: true,
        postType: true,
        account: { select: { fbPageId: true } },
      },
      // Order by csvRowIndex — preserves CSV upload order on resume.
      orderBy: { csvRowIndex: "asc" },
    });

    if (pendingPosts.length > 0) {
      const redis = getRedis();
      const now = Date.now();

      // ── Compute the resume anchor ──────────────────────────
      const lastPosted = await prisma.post.findFirst({
        where: { jobId: id, status: "posted", postedAt: { not: null } },
        orderBy: { postedAt: "desc" },
      });

      let anchor: number;
      if (lastPosted?.postedAt) {
        // one full interval after the last published post — the earliest
        // moment the next post may ever go out
        anchor = lastPosted.postedAt.getTime() + job.intervalMinutes * 60_000;
      } else {
        // nothing published yet — honor the original start time the user
        // picked at upload (legacy jobs without one: resume moment)
        anchor = job.scheduledStartAt?.getTime() ?? now;
      }
      const startAt = new Date(Math.max(anchor, now));

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

      // Persist each post's new scheduledAt — CHUNKED (100 per wave).
      // A giant single Promise.all over thousands of updates was an
      // avoidable memory/connection spike.
      const CHUNK = 100;
      for (let off = 0; off < pendingPosts.length; off += CHUNK) {
        const wave = pendingPosts.slice(off, off + CHUNK);
        await Promise.all(
          wave.map((p, j) => {
            const scheduledAt = new Date(
              startAt.getTime() + (off + j) * job.intervalMinutes * 60_000
            );
            return prisma.post.update({
              where: { id: p.id },
              data: {
                status: "scheduled",
                scheduledAt,
                bullJobId: p.id,
              },
            });
          })
        );
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
