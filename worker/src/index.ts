/**
 * FB Auto-Poster v2 — Worker Entry Point
 *
 * Standalone BullMQ consumer process.  Runs independently of the
 * Next.js web app and can be horizontally scaled.
 *
 * Responsibilities:
 * 1. Start a loopback liveness HTTP server (Docker healthcheck target)
 * 2. Register the BullMQ Workers and START CONSUMING immediately
 * 3. On boot: recover stuck 'posting' posts (crash recovery, with
 *    retry — survives a fresh deploy where the web container has not
 *    finished `prisma migrate deploy` yet) + interrupted comments
 * 4. Register cleanup repeatable jobs (Redis-lock guarded — 3 worker
 *    containers boot concurrently and must not race the registration)
 * 5. Graceful shutdown on SIGTERM/SIGINT (idempotent + time-boxed)
 */

import { Worker, type Job } from "bullmq";
import http from "node:http";
import { FacebookPoster, FacebookAPIError } from "./fb/client.js";
import { decrypt } from "./lib/encryption.js";
import { getRedis } from "./lib/redis.js";
import { prisma } from "./lib/prisma.js";
import { Prisma } from "@prisma/client";
import { FAST_QUEUE, MEDIA_QUEUE, COMMENT_QUEUE, DELETE_QUEUE, enqueueJobPosts, closeQueues, type PostJobData } from "./queues/helpers.js";
import { processPostJob, RateLimitExceededError } from "./processing/process-post.js";
import { publishCommentJob, recoverInterruptedComments, CommentSkipError } from "./processing/publish-comment.js";
import { registerCleanupJobs, processCleanupJob } from "./processing/cleanup.js";

const CLEANUP_QUEUE = "cleanup";
const VALIDATE_QUEUE = "validate";

// v2.3: sized for the 1.5 GB stack budget — see docker-compose.yml.
// 25 fast slots × 3 workers = 75 concurrent text/image posts
// (target scale: 2,000 accounts ≈ < 50 due posts/min system-wide,
// per-page rate limiter caps each page at 25 posts/min anyway).
const FAST_CONCURRENCY = parseInt(
  process.env.FAST_QUEUE_CONCURRENCY || "25",
  10
);
const MEDIA_CONCURRENCY = parseInt(
  process.env.MEDIA_QUEUE_CONCURRENCY || "5",
  10
);

// ── Graceful shutdown ─────────────────────────────────────────

const workers: Worker[] = [];
let livenessServer: http.Server | undefined;
let shuttingDown = false;

async function shutdown(signal: string) {
  // Idempotency guard: Docker sends SIGTERM, waits, then sends it
  // AGAIN right before SIGKILL. Without the guard, two concurrent
  // shutdown() runs close the same workers/queues twice and spew
  // "Connection closed" errors during an otherwise clean exit.
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n${signal} received — shutting down gracefully…`);

  // Hard deadline: if any close() hangs (e.g. Redis unreachable),
  // exit before Docker's 10s SIGKILL so `afterContainersStop` hooks
  // and log flushing still run. unref'd — never keeps the loop alive.
  const killTimer = setTimeout(() => {
    console.error("[worker] Graceful shutdown timed out — forcing exit");
    process.exit(1);
  }, 8_000);
  killTimer.unref?.();

  try {
    for (const w of workers) {
      await w.close();
    }
    await closeQueues();
    await prisma.$disconnect();
  } catch (err) {
    console.error("[worker] Error during shutdown:", err);
  } finally {
    if (livenessServer) {
      livenessServer.close();
    }
    clearTimeout(killTimer);
    process.exit(0);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// A BullMQ worker process must never die from an unhandled rejection
// in an event callback — one bad job event would take down 75 posting
// slots. Log and keep serving.
process.on("unhandledRejection", (reason) => {
  console.error("[worker] Unhandled promise rejection (worker stays up):", reason);
});

// ── Liveness server (Docker healthcheck target) ───────────────
// Binds loopback only. If the event loop is wedged (sync deadlock,
// infinite loop in a processor), this socket stops answering and the
// Docker healthcheck restarts the container — after which BullMQ's
// stalled-job mechanism (≤30s) hands this worker's in-flight jobs to
// the other workers, and the atomic Postgres status guard in
// processPostJob prevents any duplicate publish.
function startLivenessServer(): void {
  const port = parseInt(process.env.WORKER_HEALTH_PORT || "3999", 10);
  livenessServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", pid: process.pid }));
  });
  // unref: the server must never keep the process alive on shutdown
  livenessServer.unref();
  livenessServer.on("error", (err) => {
    // Port taken / permission problem — log loudly; the container
    // healthcheck will fail and Docker restarts until it is fixed.
    console.error(`[worker] Liveness server failed on 127.0.0.1:${port}:`, err);
    livenessServer = undefined;
  });
  livenessServer.listen(port, "127.0.0.1", () => {
    console.log(`[worker] Liveness endpoint: http://127.0.0.1:${port}/health`);
  });
}

// ── Boot-time recovery helpers ─────────────────────────────────

/**
 * Retry a boot-time DB step. On a FRESH deploy the workers can start
 * before the web container finishes `prisma migrate deploy` — the very
 * first queries then fail with P2021/P2022 (table does not exist).
 * Instead of crash-looping, wait and retry; the restart policy is the
 * fallback if the database is genuinely unreachable.
 */
async function withBootRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const ATTEMPTS = 5;
  const DELAY_MS = 3_000;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.warn(
        `[worker] Boot step "${label}" failed (attempt ${attempt}/${ATTEMPTS}): ${err instanceof Error ? err.message : String(err)}`
      );
      if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }
  throw lastErr;
}

/**
 * Recover stuck posts from a previous crash.
 *
 * v2.3 — the old implementation issued TWO sequential round-trips per
 * post (enqueuePost + post.update) for up to 10,000 posts ≈ minutes of
 * blocked startup during which no posts were processed. Now:
 *   - the status flip (posting → scheduled) is one updateMany (unchanged)
 *   - the overdue-post re-enqueue uses enqueueJobPosts (addBulk, 500 per
 *     pipelined Redis round-trip, delay 0 — they are all past due)
 *   - the redundant per-post bullJobId sync is one raw SQL statement
 *     per 500 posts (bullJobId = id for every row; v2.2 uploads already
 *     set this, the sync only matters for pre-v2.2 rows)
 */
async function recoverStuckPosts(): Promise<void> {
  const stuckCount = await prisma.post.updateMany({
    where: { status: "posting" },
    data: { status: "scheduled", scheduledAt: new Date() },
  });
  if (stuckCount.count === 0) return;
  console.log(`[worker] Recovered ${stuckCount.count} stuck post(s) from previous crash`);

  // Re-enqueue ALL overdue scheduled posts (safety net — this covers
  // the just-recovered rows plus any scheduled row whose queue entry
  // was lost, e.g. Redis flushed while workers were down).
  const recoveredPosts = await prisma.post.findMany({
    where: {
      status: "scheduled",
      scheduledAt: { lte: new Date() },
    },
    select: {
      id: true,
      jobId: true,
      accountId: true,
      postType: true,
      csvRowIndex: true,
      account: { select: { fbPageId: true } },
    },
    // Order by csvRowIndex so recovered posts are re-enqueued in
    // their original CSV order (deterministic).
    orderBy: { csvRowIndex: "asc" },
    take: 10_000, // safety cap
  });

  const redis = getRedis();
  // All rows are past due → startAt = now, interval 0 → delay 0.
  // jobId = postId keeps the enqueue idempotent (a re-add while an
  // old entry still exists is a silent no-op).
  await enqueueJobPosts(
    redis,
    recoveredPosts.map((p) => ({
      id: p.id,
      jobId: p.jobId,
      accountId: p.accountId,
      pageId: p.account.fbPageId,
      postType: p.postType,
      index: 0,
      intervalMinutes: 0,
      startAt: new Date(),
    }))
  );

  // Sync bullJobId = id in bulk (informational field; one statement
  // per 500 rows instead of one update per post).
  const SQL_CHUNK = 500;
  for (let off = 0; off < recoveredPosts.length; off += SQL_CHUNK) {
    const ids = recoveredPosts.slice(off, off + SQL_CHUNK).map((p) => p.id);
    await prisma.$executeRaw`UPDATE "Post" SET "bullJobId" = "id" WHERE "id" IN (${Prisma.join(ids)})`;
  }

  console.log(`[worker] Re-enqueued ${recoveredPosts.length} overdue post(s)`);
}

// ── Boot ─────────────────────────────────────────────────────

async function main() {
  // Refuse to boot with placeholder secrets
  const encKey = process.env.ENCRYPTION_KEY;
  if (!encKey) {
    throw new Error(
      "ENCRYPTION_KEY environment variable is required. Refusing to start."
    );
  }

  // 1. Liveness endpoint FIRST — the container must be able to report
  //    healthy (or fail) during the DB recovery phase below.
  startLivenessServer();

  const redis = getRedis();
  console.log(`[worker] Redis client created (${process.env.REDIS_URL ? "configured" : "MISSING REDIS_URL"})`);

  // ── 2. Create + start the queue workers BEFORE recovery ─────
  // Recovery only flips 'posting' rows back to 'scheduled' — workers
  // cannot touch those rows until then, so starting the workers first
  // is safe and removes the old dead window (recovery used to block
  // worker startup for minutes on large crash recoveries).

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

  // ── Cleanup worker ─────────────────────────────────────

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

  // ── Validate worker ────────────────────────────────────
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

  // ── Comment worker (unified comment publisher) ────────
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

  // ── Delete-post worker ─────────────────────────────────
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

  // ── Event logging ───────────────────────────────────────

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

  // ── 3. Start consuming FIRST (no dead window during recovery) ─
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

  // ── 4. Crash recovery (with retry for fresh-deploy ordering) ─
  // If the DB is still migrating on a first-ever deploy, retry instead
  // of crash-looping. Exhausted retries exit(1) → Docker restarts with
  // backoff and the next boot retries the whole sequence.
  await withBootRetry("recover-stuck-posts", recoverStuckPosts);

  // Recover comments interrupted by a previous crash. A comment stuck
  // in 'processing' across a worker restart has an UNKNOWN outcome —
  // flag it for manual review instead of guessing. If its BullMQ job
  // is re-delivered later, the retry-verification in publishCommentJob
  // prevents a duplicate comment.
  await withBootRetry("recover-interrupted-comments", async () => {
    const interruptedComments = await recoverInterruptedComments();
    if (interruptedComments > 0) {
      console.log(
        `[worker] Flagged ${interruptedComments} interrupted comment(s) for review`
      );
    }
  });

  // ── 5. Register scheduled cleanup jobs (Redis-lock guarded) ─
  await withBootRetry("register-cleanup-jobs", registerCleanupJobs);
}

main().catch((err) => {
  console.error("[worker] Fatal startup error:", err);
  process.exit(1);
});
