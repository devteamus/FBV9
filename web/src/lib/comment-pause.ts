/**
 * Pause / resume tracked comments together with their posts.
 *
 * Pause:  every still-pending comment → status "paused", its delayed
 *         BullMQ job is removed. A job that slips through (already active
 *         or re-delivered) is rejected by the worker's atomic status guard
 *         because "paused" is not a publishable status.
 *
 * Resume: every "paused" comment → "pending" and re-queued:
 *         - not yet due  (post.postedAt + delay still in the future):
 *           fires at its ORIGINAL time
 *         - overdue (came due while paused): fires right after resume,
 *           one comment per account every 10 s (no burst on a page)
 */

import type { Redis } from "ioredis";
import { prisma } from "@/lib/prisma";
import { cancelCommentJobs, enqueueComment } from "@/lib/queues/helpers";

type Where = Record<string, unknown>;

const CHUNK = 1000;

export async function pauseComments(redis: Redis, where: Where): Promise<number> {
  const rows = await prisma.scheduledComment.findMany({
    where: { ...where, status: "pending" },
    select: { id: true },
  });
  if (rows.length === 0) return 0;
  const ids = rows.map((r) => r.id);

  // DB first: once "paused", any job that still fires is rejected.
  for (let off = 0; off < ids.length; off += CHUNK) {
    await prisma.scheduledComment.updateMany({
      where: { id: { in: ids.slice(off, off + CHUNK) }, status: "pending" },
      data: { status: "paused" },
    });
  }
  await cancelCommentJobs(redis, ids);
  return ids.length;
}

export async function resumePausedComments(redis: Redis, where: Where): Promise<number> {
  const rows = await prisma.scheduledComment.findMany({
    where: { ...where, status: "paused" },
    select: {
      id: true,
      delayMinutes: true,
      accountId: true,
      fbPostId: true,
      post: { select: { postedAt: true, fbPostId: true, status: true, accountId: true } },
    },
  });
  if (rows.length === 0) return 0;

  const now = Date.now();
  // unique BullMQ jobId suffix per resume (the plain id may still exist as a
  // completed job in Redis, which would make a re-add a silent no-op)
  const attemptTag = Math.floor(now / 1000);

  const plan = rows.map((r) => {
    const fbPostId = r.fbPostId ?? r.post.fbPostId;
    const dueAt = r.post.postedAt ? r.post.postedAt.getTime() + r.delayMinutes * 60_000 : now;
    return { row: r, fbPostId, dueAt, accountKey: r.accountId ?? r.post.accountId };
  });
  // overdue first, in their original order, so the per-account rank keeps it
  plan.sort((a, b) => a.dueAt - b.dueAt);

  const rankByAccount = new Map<string, number>();
  const jobs = plan.map((p) => {
    let fireAt: number;
    if (p.dueAt > now) {
      fireAt = p.dueAt;
    } else {
      const rank = rankByAccount.get(p.accountKey) ?? 0;
      rankByAccount.set(p.accountKey, rank + 1);
      fireAt = now + rank * 10_000;
    }
    return { ...p, fireAt };
  });

  // Flip back to pending first (so the worker guard accepts the job)
  const ids = jobs.map((j) => j.row.id);
  for (let off = 0; off < ids.length; off += CHUNK) {
    await prisma.scheduledComment.updateMany({
      where: { id: { in: ids.slice(off, off + CHUNK) }, status: "paused" },
      data: { status: "pending" },
    });
  }

  const failed: string[] = [];
  const WAVE = 50;
  for (let off = 0; off < jobs.length; off += WAVE) {
    const wave = jobs.slice(off, off + WAVE);
    const results = await Promise.allSettled(
      wave.map(async (j) => {
        if (!j.fbPostId || j.row.post.status !== "posted") return; // worker would skip anyway
        await enqueueComment(
          redis,
          { scheduledCommentId: j.row.id, fbPostId: j.fbPostId },
          new Date(j.fireAt),
          attemptTag
        );
      })
    );
    results.forEach((r, i) => {
      if (r.status === "rejected") failed.push(wave[i].row.id);
    });
  }

  // Could not re-queue → surface on the Missing Comments page for manual retry
  if (failed.length > 0) {
    for (let off = 0; off < failed.length; off += CHUNK) {
      await prisma.scheduledComment.updateMany({
        where: { id: { in: failed.slice(off, off + CHUNK) } },
        data: { status: "failed", errorMessage: "Could not re-queue after resume — use Retry" },
      });
    }
  }
  return ids.length - failed.length;
}
