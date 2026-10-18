/**
 * BullMQ queue helpers — enqueue, re-enqueue, cancel, scheduling.
 *
 * The web API routes import these (via a shared module) to enqueue jobs.
 * The worker imports these for re-enqueue on retry.
 *
 * Job data payload: { postId, jobId, accountId, pageId, postType }
 * Full post details are loaded from Postgres at execution time (not
 * stuffed into Redis — keeps payloads small).
 */

import { Queue, type Job } from "bullmq";
import type { Redis } from "ioredis";

// IMPORTANT: BullMQ 5.x disallows ":" in queue names.
// Use hyphen-separated names instead.
export const FAST_QUEUE = "posts-fast";
export const MEDIA_QUEUE = "posts-media";
export const COMMENT_QUEUE = "comments-delayed";
export const DELETE_QUEUE = "delete-post";

export interface PostJobData {
  postId: string;
  jobId: string;
  accountId: string;
  pageId: string;
  postType: string; // text|image|video|reel
  attempt?: number; // current retry attempt (1-based)
}

let fastQueue: Queue | undefined;
let mediaQueue: Queue | undefined;
let commentQueue: Queue | undefined;
let deleteQueue: Queue | undefined;

function getQueue(queueName: string, redis: Redis): Queue {
  if (queueName === FAST_QUEUE) {
    if (!fastQueue) {
      fastQueue = new Queue(queueName, {
        connection: redis.duplicate(),
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: { count: 1000 },
          removeOnFail: { count: 5000 },
        },
      });
    }
    return fastQueue;
  }
  if (queueName === MEDIA_QUEUE) {
    if (!mediaQueue) {
      mediaQueue = new Queue(queueName, {
        connection: redis.duplicate(),
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: "exponential", delay: 10000 },
          // Longer backoff for media (videos/reels are expensive)
          removeOnComplete: { count: 1000 },
          removeOnFail: { count: 5000 },
        },
      });
    }
    return mediaQueue;
  }
  if (queueName === COMMENT_QUEUE) {
    if (!commentQueue) {
      commentQueue = new Queue(queueName, {
        connection: redis.duplicate(),
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: { count: 1000 },
          removeOnFail: { count: 5000 },
        },
      });
    }
    return commentQueue;
  }
  // DELETE_QUEUE
  if (!deleteQueue) {
    deleteQueue = new Queue(queueName, {
      connection: redis.duplicate(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });
  }
  return deleteQueue;
}

/**
 * Resolve which queue a post type belongs to.
 */
export function resolveQueueName(postType: string): string {
  if (postType === "video" || postType === "reel") return MEDIA_QUEUE;
  return FAST_QUEUE;
}

/**
 * Enqueue a single post for execution.
 * If scheduledAt is in the future, uses BullMQ's native delayed job
 * (no polling — Redis fires when due, per §3).
 *
 * IMPORTANT — BullMQ custom-jobId dedup semantics: when a job with the
 * same custom jobId already exists in Redis (waiting/delayed/active, or
 * completed/failed before keep-limits prune it), `queue.add()` is a
 * SILENT NO-OP (the addStandardJob/addDelayedJob Lua scripts only emit a
 * `duplicated` event and return the existing id — no new job is created).
 *
 * That is exactly what we want for first-time enqueues (idempotency), but
 * it is a trap for RE-enqueues made from inside a processor (rate-limit
 * backoff): at that moment the currently-running job's key still exists,
 * so re-adding with the same `postId` jobId would be dropped and the post
 * would stay "scheduled" in Postgres with no queue job — stuck forever.
 *
 * Fix: such callers MUST pass a unique `retryTag` (e.g. `rl${Date.now()}`)
 * so the retry gets a fresh jobId (`${postId}-${retryTag}`). Double-
 * publishing remains impossible thanks to the atomic Postgres status guard
 * in processPostJob (`status IN (pending, scheduled)` → `posting`).
 *
 * (Hyphen separator, NOT a colon: BullMQ 5.x throws "Custom Id cannot
 * contain :" for 2-part colon jobIds.)
 */
export async function enqueuePost(
  redis: Redis,
  data: PostJobData,
  scheduledAt?: Date,
  retryTag?: string
): Promise<Job<PostJobData, unknown, string>> {
  const queueName = resolveQueueName(data.postType);
  const queue = getQueue(queueName, redis);

  const jobOpts: { delay?: number; jobId?: string } = {};
  if (scheduledAt) {
    const delay = Math.max(0, scheduledAt.getTime() - Date.now());
    if (delay > 0) {
      jobOpts.delay = delay;
    }
  }
  // Use postId as BullMQ jobId for idempotency — prevents duplicate enqueue.
  // A retryTag suffix is only used for re-enqueues from inside a processor
  // (see the comment above for why the plain postId would be dropped).
  jobOpts.jobId = retryTag ? `${data.postId}-${retryTag}` : data.postId;

  const job = await queue.add(`post:${data.postId}`, data, jobOpts);
  return job;
}

/**
 * Bulk enqueue posts from a job (e.g. on CSV upload or job resume).
 * Computes each post's scheduledAt based on intervalMinutes.
 */
export async function enqueueJobPosts(
  redis: Redis,
  posts: Array<{
    id: string;
    jobId: string;
    accountId: string;
    pageId: string;
    postType: string;
    index: number; // 0-based position in job
    intervalMinutes: number;
    startAt: Date;
  }>
): Promise<void> {
  for (const p of posts) {
    const scheduledAt = new Date(
      p.startAt.getTime() + p.index * p.intervalMinutes * 60_000
    );
    await enqueuePost(
      redis,
      {
        postId: p.id,
        jobId: p.jobId,
        accountId: p.accountId,
        pageId: p.pageId,
        postType: p.postType,
      },
      scheduledAt
    );
  }
}

/**
 * Enqueue a delayed comment for a post that has already gone live.
 * Uses BullMQ's native `delay` — no polling, Redis fires it when due.
 *
 * jobId scheme (idempotency, §3):
 *   - first attempt / scheduled fire: the ScheduledComment's own id
 *     (re-running the enqueue step, e.g. worker restart recovery, is a no-op)
 *   - manual retry / rate-limit re-schedule: `${id}-a${attempt}` where
 *     attempt = the attempt number this job will perform. A double-clicked
 *     retry button dedupes to a single BullMQ job (same custom jobId), while
 *     a later legitimate retry (next attempt number) gets a fresh job.
 *
 * NOTE: the separator is a HYPHEN, not a colon — BullMQ 5.x throws
 * "Custom Id cannot contain :" for custom jobIds unless they split into
 * exactly 3 colon-separated parts (legacy repeatable-job format only).
 */
export async function enqueueComment(
  redis: Redis,
  data: { scheduledCommentId: string; fbPostId: string },
  fireAt: Date,
  attempt?: number
): Promise<void> {
  const queue = getQueue(COMMENT_QUEUE, redis);
  const delay = Math.max(0, fireAt.getTime() - Date.now());
  const jobId =
    attempt && attempt > 1
      ? `${data.scheduledCommentId}-a${attempt}`
      : data.scheduledCommentId;
  await queue.add("comment", data, {
    delay,
    jobId,
  });
}

/**
 * Enqueue a Facebook post deletion. Runs in the worker (never from the
 * web process directly) so Graph API credentials/calls stay in one place.
 *
 * Retry semantics: the base jobId `delete-${postId}` dedupes double-clicks
 * while a delete is waiting/active (intended). But after an attempt lands
 * in a TERMINAL state (completed/failed), its Redis key still exists until
 * the keep-limits prune it — re-adding with the same jobId would be a
 * silent no-op and the user's "delete again" click would do nothing.
 * So when the previous job is terminal we mint a fresh suffixed jobId.
 */
export async function enqueueDeletePost(
  redis: Redis,
  data: { postId: string; fbPostId: string; accountId: string }
): Promise<void> {
  const queue = getQueue(DELETE_QUEUE, redis);
  const baseId = `delete-${data.postId}`;
  let jobId = baseId;
  try {
    const existing = await queue.getJob(baseId);
    if (existing) {
      const state = await existing.getState();
      if (state === "completed" || state === "failed" || state === "unknown") {
        // Previous attempt is terminal (or its state can no longer be
        // determined) — allow a genuinely fresh delete job.
        jobId = `${baseId}-r${Date.now()}`;
      }
      // waiting / delayed / active → keep baseId: BullMQ dedupes the
      // re-add, which is the desired in-flight double-click protection.
    }
  } catch {
    // State lookup failed (e.g. Redis hiccup) — fall back to previous
    // behavior (base id) rather than blocking the user's action.
  }
  await queue.add("delete", data, { jobId });
}

/**
 * Remove (cancel) a specific post's BullMQ job.
 * Suffix-aware: also removes rate-limit retry jobs (`${postId}-rl…`)
 * created by processPostJob's backoff path, by scanning the live sets and
 * matching on the job payload's postId (the BullMQ jobId alone no longer
 * uniquely identifies a post's queue entries).
 */
export async function cancelPostJob(
  redis: Redis,
  postId: string,
  postType: string
): Promise<boolean> {
  const queueName = resolveQueueName(postType);
  const queue = getQueue(queueName, redis);
  try {
    const job = await queue.getJob(postId);
    if (job) {
      await job.remove();
      return true;
    }
    for (const state of ["waiting", "delayed", "active"] as const) {
      const jobs = await queue.getJobs([state]);
      for (const j of jobs) {
        if (j.data && (j.data as PostJobData).postId === postId) {
          await j.remove();
          return true;
        }
      }
    }
  } catch {
    // Job may not exist — that's fine
  }
  return false;
}

/**
 * Cancel all BullMQ jobs for a given job ID.
 * Used when a job is paused or deleted.
 */
export async function cancelJobPosts(
  redis: Redis,
  jobId: string
): Promise<number> {
  let cancelled = 0;
  for (const queueName of [FAST_QUEUE, MEDIA_QUEUE]) {
    const queue = getQueue(queueName, redis);
    const jobs = await queue.getJobs(["waiting", "delayed", "active"]);
    for (const job of jobs) {
      if (job.data.jobId === jobId) {
        await job.remove();
        cancelled++;
      }
    }
  }
  return cancelled;
}

/**
 * Close queue connections (for graceful shutdown).
 */
export async function closeQueues(): Promise<void> {
  if (fastQueue) { await fastQueue.close(); fastQueue = undefined; }
  if (mediaQueue) { await mediaQueue.close(); mediaQueue = undefined; }
  if (commentQueue) { await commentQueue.close(); commentQueue = undefined; }
  if (deleteQueue) { await deleteQueue.close(); deleteQueue = undefined; }
}
