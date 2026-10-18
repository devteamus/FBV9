/**
 * FB Auto-Poster v2 — Worker Entry Point
 *
 * Standalone BullMQ consumer process.  Runs independently of the
 * Next.js web app and can be horizontally scaled.
 *
 * Responsibilities:
 * 1. On boot: recover stuck 'posting' posts (crash recovery)
 * 2. Register two BullMQ Workers: posts-fast + posts-media
 * 3. Register cleanup worker (CSV + old job purge)
 * 4. Graceful shutdown on SIGTERM/SIGINT
 */

import { Worker, type Job } from "bullmq";
import { FacebookPoster, FacebookAPIError } from "./fb/client.js";
import { decrypt } from "./lib/encryption.js";
import { getRedis } from "./lib/redis.js";
import { prisma } from "./lib/prisma.js";
import { FAST_QUEUE, MEDIA_QUEUE, COMMENT_QUEUE, DELETE_QUEUE, enqueuePost, closeQueues, type PostJobData } from "./queues/helpers.js";
import { processPostJob, RateLimitExceededError } from "./processing/process-post.js";
import { publishCommentJob, recoverInterruptedComments, CommentSkipError } from "./processing/publish-comment.js";
import { registerCleanupJobs, processCleanupJob } from "./processing/cleanup.js";

const CLEANUP_QUEUE = "cleanup";
const VALIDATE_QUEUE = "validate";

const FAST_CONCURRENCY = parseInt(
  process.env.FAST_QUEUE_CONCURRENCY || "50",
  10
);
const MEDIA_CONCURRENCY = parseInt(
  process.env.MEDIA_QUEUE_CONCURRENCY || "5",
  10
);

// ── Graceful shutdown ─────────────────────────────────────────

const workers: Worker[] = [];

async function shutdown(signal: string) {
  console.log(`\n${signal} received — shutting down gracefully…`);
  for (const w of workers) {
    await w.close();
  }
  await closeQueues();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// ── Boot ─────────────────────────────────────────────────────

async function main() {
  // Refuse to boot with placeholder secrets
  const encKey = process.env.ENCRYPTION_KEY;
  if (!encKey) {
    throw new Error(
      "ENCRYPTION_KEY environment variable is required. Refusing to start."
    );
  }

  const redis = getRedis();
  console.log(`[worker] Connected to Redis`);

  // ── 1. Recover stuck posts from a previous crash ───────
  // Matches v1's _resume_interrupted_jobs intent, but only for
  // true crash recovery (BullMQ tracks active jobs reliably)
  const stuckCount = await prisma.post.updateMany({
    where: { status: "posting" },
    data: { status: "scheduled", scheduledAt: new Date() },
  });
  if (stuckCount.count > 0) {
    console.log(
      `[worker] Recovered ${stuckCount.count} stuck post(s) from previous crash`
    );

    // Re-enqueue recovered posts into BullMQ
    const recoveredPosts = await prisma.post.findMany({
      where: {
        status: "scheduled",
        scheduledAt: { lte: new Date() },
      },
      include: { account: true },
      // Order by csvRowIndex so recovered posts are re-enqueued in
      // their original CSV order (deterministic) instead of in some
      // arbitrary DB row order.
      orderBy: { csvRowIndex: "asc" },
      take: 10_000, // safety cap
    });

    for (const post of recoveredPosts) {
      try {
        await enqueuePost(redis, {
          postId: post.id,
          jobId: post.jobId,
          accountId: post.accountId,
          pageId: post.account.fbPageId,
          postType: post.postType,
        });
        // Update bullJobId for tracking
        await prisma.post.update({
          where: { id: post.id },
          data: { bullJobId: post.id },
        });
      } catch (err) {
        console.warn(
          `[worker] Failed to re-enqueue post ${post.id}: ${err}`
        );
      }
    }
    console.log(
      `[worker] Re-enqueued ${recoveredPosts.length} recovered post(s)`
    );
  }

  // ── 1b. Recover comments interrupted by a previous crash ─
  // A comment stuck in 'processing' across a worker restart has an
  // UNKNOWN outcome — flag it for manual review instead of guessing.
  // If its BullMQ job is re-delivered later, the retry-verification in
  // publishCommentJob prevents a duplicate comment.
  const interruptedComments = await recoverInterruptedComments();
  if (interruptedComments > 0) {
    console.log(
      `[worker] Flagged ${interruptedComments} interrupted comment(s) for review`
    );
  }

  // ── 2. Register post queue workers ─────────────────────

  function createPostProcessor(queueLabel: string) {
    return async (job: Job<PostJobData, void, string>) => {
      const { postId, postType } = job.data;
      console.log(
        `[${queueLabel}] Processing BullMQ job ${job.id} — postId: ${postId}, type: ${postType}, attempt: ${job.attemptsMade + 1}`
      );
      try {
        await processPostJob({
          ...job.data,
          attempt: job.attemptsMade + 1,
        });
      } catch (err) {
        // Rate limit errors: don't count toward BullMQ's built-in retry
        // (we handle them with per-page backoff + re-scheduling)
        if (err instanceof RateLimitExceededError) {
          console.warn(
            `[${queueLabel}] Rate limited (page ${err.pageId}): ${err.message} — not failing, will retry via schedule`
          );
          // Return without throwing so BullMQ considers this "completed"
          // The post was already re-scheduled in processPostJob
          return;
        }

        // For all other errors: mark post as failed in DB
        console.error(
          `[${queueLabel}] Post ${postId} error: ${err instanceof Error ? err.message : String(err)}`
        );

        const isFinalAttempt =
          job.attemptsMade + 1 >= (job.opts?.attempts ?? 3);

        if (isFinalAttempt) {
          await prisma.post.update({
            where: { id: postId },
            data: {
              status: "failed",
              errorMessage: err instanceof Error
                ? err.message.substring(0, 1000)
                : String(err).substring(0, 1000),
            },
          });
          // Update job counters
          const post = await prisma.post.findUnique({
            where: { id: postId },
            select: { jobId: true },
          });
          if (post) {
            const counts = await prisma.post.groupBy({
              by: ["status"],
              where: { jobId: post.jobId },
              _count: true,
            });
            const completed =
              counts.find((c) => c.status === "posted")?._count ?? 0;
            const failed =
              counts.find((c) => c.status === "failed")?._count ?? 0;
            await prisma.job.update({
              where: { id: post.jobId },
              data: { completedPosts: completed, failedPosts: failed },
            });
          }
          console.error(
            `[${queueLabel}] Post ${postId} permanently failed after all retries`
          );
        }

        // Re-throw so BullMQ retries
        throw err;
      }
    };
  }

  const fastWorker = new Worker(
    FAST_QUEUE,
    createPostProcessor("fast"),
    {
      connection: redis.duplicate(),
      concurrency: FAST_CONCURRENCY,
      autorun: false,
    }
  );

  const mediaWorker = new Worker(
    MEDIA_QUEUE,
    createPostProcessor("media"),
    {
      connection: redis.duplicate(),
      concurrency: MEDIA_CONCURRENCY,
      autorun: false,
    }
  );

  // ── 3. Register cleanup worker ─────────────────────────

  const cleanupWorker = new Worker(
    CLEANUP_QUEUE,
    async (job) => {
      console.log(`[cleanup] Running: ${job.name}`);
      await processCleanupJob(job.name);
    },
    {
      connection: redis.duplicate(),
      concurrency: 1,
      autorun: false,
    }
  );

  // ── 3b. Register validate worker ─────────────────────
  // Handles token validation requests from the web API (§10: no Graph API from web)

  const validateWorker = new Worker(
    VALIDATE_QUEUE,
    async (job) => {
      const { accountId, encryptedToken, fbPageId, fbApiVersion } = job.data as {
        accountId: string;
        encryptedToken: string;
        fbPageId: string;
        fbApiVersion: string;
      };
      try {
        const accessToken = await decrypt(encryptedToken);
        const poster = new FacebookPoster(accessToken, fbPageId, fbApiVersion);
        const page = await poster.validate();
        // Persist the page profile picture (public CDN url) so the
        // dashboard can render avatars without any Graph API call
        // from the web process (§10). Failure to persist is non-fatal.
        if (page.picture) {
          try {
            await prisma.account.update({
              where: { id: accountId },
              data: { fbPagePictureUrl: page.picture },
            });
          } catch (picErr) {
            console.warn(
              `[validate] Could not persist page picture for ${accountId}: ${picErr}`
            );
          }
        }
        return { success: true, page: { id: page.id, name: page.name } };
      } catch (err) {
        const msg = err instanceof FacebookAPIError
          ? err.message
          : err instanceof Error ? err.message : String(err);
        return { success: false, error: msg };
      }
    },
    {
      connection: redis.duplicate(),
      concurrency: 3,
      autorun: false,
    }
  );

  // ── 3c. Register comment worker (unified comment publisher) ─
  // Every comment — CSV immediate, CSV delayed, manual publish, retry,
  // bulk retry — flows through publishCommentJob, which enforces the
  // atomic status guard, per-page rate limit, retry verification
  // (duplicate prevention) and uncertain-outcome review flagging.

  const commentWorker = new Worker(
    COMMENT_QUEUE,
    async (job) => {
      const { scheduledCommentId } = job.data as {
        scheduledCommentId: string;
        fbPostId: string;
      };
      try {
        await publishCommentJob(scheduledCommentId);
      } catch (err) {
        if (err instanceof CommentSkipError) {
          // Expected, non-retryable conditions (already published, parent
          // gone, rate-limited reschedule...). Logged, not failed.
          console.log(`[comment] ${scheduledCommentId} skipped: ${err.message}`);
          return;
        }
        // Unexpected (e.g. DB unreachable) — let BullMQ retry the job.
        throw err;
      }
    },
    { connection: redis.duplicate(), concurrency: 10, autorun: false }
  );

  // ── 3d. Register delete-post worker ─────────────────────
  // Deletes a published post/photo/video/reel from Facebook on request
  // from the dashboard. Runs here (not in the web process) so Graph API
  // calls stay in one place, same reasoning as the validate worker.

  const deleteWorker = new Worker(
    DELETE_QUEUE,
    async (job) => {
      const { postId, fbPostId, accountId } = job.data as {
        postId: string;
        fbPostId: string;
        accountId: string;
      };

      const account = await prisma.account.findUnique({ where: { id: accountId } });
      if (!account) {
        throw new Error(`Account ${accountId} not found`);
      }

      try {
        const accessToken = await decrypt(account.fbPageAccessToken);
        const poster = new FacebookPoster(accessToken, account.fbPageId, account.fbApiVersion);
        await poster.deletePost(fbPostId);
        await prisma.post.update({
          where: { id: postId },
          data: { status: "deleted" },
        });
        console.log(`[delete] Post ${postId} (fb: ${fbPostId}) deleted from Facebook`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const fbCode = err instanceof FacebookAPIError ? err.code : "";

        // Target no longer exists on Facebook (code 100 = non-existing
        // object, 803 = alias/id does not exist — e.g. it was already
        // deleted manually on Facebook). The user's intent ("remove this
        // post from Facebook") is already satisfied — mark it deleted
        // instead of erroring forever on an un-retryable target.
        if (fbCode === "100" || fbCode === "803") {
          await prisma.post.update({
            where: { id: postId },
            data: { status: "deleted", errorMessage: null },
          });
          console.log(
            `[delete] Post ${postId} (fb: ${fbPostId}) already gone from Facebook — marked deleted`
          );
          return;
        }

        await prisma.post.update({
          where: { id: postId },
          data: { errorMessage: `Delete failed: ${msg}`.substring(0, 1000) },
        });
        throw err; // let BullMQ retry a genuine failure (e.g. transient network error)
      }
    },
    { connection: redis.duplicate(), concurrency: 5, autorun: false }
  );

  workers.push(fastWorker, mediaWorker, cleanupWorker, validateWorker, commentWorker, deleteWorker);

  // ── 4. Event logging ───────────────────────────────────

  for (const [label, w] of [
    ["fast", fastWorker],
    ["media", mediaWorker],
    ["cleanup", cleanupWorker],
    ["validate", validateWorker],
    ["comment", commentWorker],
    ["delete", deleteWorker],
  ] as const) {
    w.on("completed", (job) => {
      console.log(`[${label}] Job ${job.id} completed`);
    });
    w.on("failed", (job, err) => {
      console.error(
        `[${label}] Job ${job?.id} failed (attempt ${job?.attemptsMade ?? "?"}): ${err.message}`
      );
    });
    w.on("error", (err) => {
      console.error(`[${label}] Worker error: ${err.message}`);
    });
  }

  // ── 5. Register scheduled cleanup jobs ─────────────────
  await registerCleanupJobs();

  // ── 6. Start consuming ─────────────────────────────────
  fastWorker.run();
  mediaWorker.run();
  cleanupWorker.run();
  validateWorker.run();
  commentWorker.run();
  deleteWorker.run();

  console.log(`[worker] ═══════════════════════════════════════`);
  console.log(`[worker] FB Auto-Poster v2 Worker`);
  console.log(`[worker] ${FAST_QUEUE} concurrency=${FAST_CONCURRENCY}`);
  console.log(`[worker] ${MEDIA_QUEUE} concurrency=${MEDIA_CONCURRENCY}`);
  console.log(`[worker] Ready`);
  console.log(`[worker] ═══════════════════════════════════════`);
}

main().catch((err) => {
  console.error("[worker] Fatal startup error:", err);
  process.exit(1);
});
