/**
 * Core post processing logic — called by BullMQ worker for each job.
 *
 * Flow:
 * 1. Load Post + Account from Postgres by postId
 * 2. Atomic status check: UPDATE ... SET status='posting' WHERE status IN ('pending','scheduled')
 *    (Postgres-level idempotency safety net per §3)
 * 3. Per-page rate limit check (scoped by pageId, per §3)
 * 4. Decrypt account token
 * 5. Call appropriate Graph API method (§6 — exact v1 logic)
 * 6. Update post status to 'posted' or 'failed'
 * 7. Update job counters (completedPosts / failedPosts)
 * 8. Handle optional comment (failure never fails the parent post)
 * 9. Check if job is now complete
 * 10. On rate-limit error: throw with special code so BullMQ retries with backoff
 */

import { prisma } from "../lib/prisma.js";
import { decrypt } from "../lib/encryption.js";
import { FacebookPoster, FacebookAPIError } from "../fb/client.js";
import { checkRateLimit, getRateLimitBackoff } from "../rate-limiter/per-page.js";
import { getRedis } from "../lib/redis.js";
import { enqueuePost, enqueueComment, type PostJobData } from "../queues/helpers.js";

export class RateLimitExceededError extends Error {
  pageId: string;
  constructor(pageId: string, message: string) {
    super(message);
    this.name = "RateLimitExceededError";
    this.pageId = pageId;
  }
}

export async function processPostJob(jobData: PostJobData): Promise<void> {
  const { postId, postType } = jobData;

  // ── 1. Load post with account from Postgres ──────────────
  const post = await prisma.post.findUnique({
    where: { id: postId },
    include: {
      account: true,
    },
  });

  if (!post) {
    throw new Error(`Post ${postId} not found in database`);
  }

  // ── 2. Atomic status guard (Postgres-level idempotency) ──
  // Only proceed if the post is still in aprocessable state.
  // This protects against duplicate execution from manual re-enqueues.
  const updated = await prisma.post.updateMany({
    where: {
      id: postId,
      status: { in: ["pending", "scheduled"] },
    },
    data: { status: "posting" },
  });

  if (updated.count === 0) {
    // Post was already processed or is in a terminal state — skip
    console.log(`[process] Post ${postId} skipped — status is '${post.status}', not processable`);
    return;
  }

  const account = post.account;
  if (!account || !account.isActive) {
    await prisma.post.update({
      where: { id: postId },
      data: {
        status: "failed",
        errorMessage: "Account is deactivated or not found",
      },
    });
    await updateJobCounters(post.jobId);
    return;
  }

  // ── 3. Per-page rate limit check (§3) ───────────────────
  const redis = getRedis();
  const rateResult = await checkRateLimit(redis, account.fbPageId);

  if (!rateResult.allowed) {
    // Revert to scheduled so it can be retried
    const retryAt = new Date(Date.now() + 60_000);
    await prisma.post.update({
      where: { id: postId },
      data: {
        status: "scheduled",
        scheduledAt: retryAt,
      },
    });
    // Re-enqueue into BullMQ with delay so a worker picks it up.
    // CRITICAL: the retryTag (fresh jobId suffix) is required — this call
    // runs while the CURRENT job (same custom jobId = postId) is still
    // active in Redis, and BullMQ silently no-ops a re-add whose jobId
    // already exists. Without the suffix the post would be stuck in
    // "scheduled" forever with no queue job. The atomic status guard in
    // this function guarantees a retry can never double-publish.
    //
    // v2.2 — the tag is DETERMINISTIC (`rl${retryAt.getTime()}`) and
    // equals the post's persisted scheduledAt. Pause/delete can then
    // probe `${postId}-rl${scheduledAtMs}` directly (see
    // cancelJobPostsByIds) instead of scanning whole queues — which at
    // tens of thousands of delayed jobs was an OOM risk.
    await enqueuePost(
      redis,
      {
        postId: post.id,
        jobId: post.jobId,
        accountId: post.accountId,
        pageId: account.fbPageId,
        postType: post.postType,
      },
      retryAt,
      `rl${retryAt.getTime()}`
    );
    throw new RateLimitExceededError(
      account.fbPageId,
      `Page ${account.fbPageId} rate limited. Remaining: ${rateResult.remaining}`
    );
  }

  // ── 4. Decrypt the page access token (§7B) ─────────────
  let accessToken: string;
  try {
    accessToken = await decrypt(account.fbPageAccessToken);
  } catch (err) {
    await prisma.post.update({
      where: { id: postId },
      data: {
        status: "failed",
        errorMessage: `Token decryption failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    });
    await updateJobCounters(post.jobId);
    return;
  }

  // ── 5. Create FacebookPoster and execute ───────────────
  const poster = new FacebookPoster(
    accessToken,
    account.fbPageId,
    account.fbApiVersion
  );

  const startTime = Date.now();
  let fbPostId: string | undefined;

  try {
    let result: { id: string };

    switch (postType) {
      case "video":
        result = await poster.postVideo(post.caption, post.mediaUrl);
        break;
      case "reel":
        result = await poster.postReel(post.caption, post.mediaUrl);
        break;
      case "text":
        result = await poster.postText(post.caption);
        break;
      case "image":
      default:
        result = await poster.postImage(post.caption, post.mediaUrl);
        break;
    }

    fbPostId = result.id;
  } catch (err) {
    const duration = Date.now() - startTime;

    if (err instanceof FacebookAPIError) {
      // Check if it's a Facebook rate-limit error (code 4 or 80004 or similar)
      const isRateLimit = ["4", "80004", "368", "613"].includes(err.code);

      if (isRateLimit) {
        // Revert to scheduled, re-enqueue with backoff
        const attempt = jobData.attempt || 1;
        const retryAt = new Date(Date.now() + getRateLimitBackoff(attempt));
        await prisma.post.update({
          where: { id: postId },
          data: {
            status: "scheduled",
            scheduledAt: retryAt,
          },
        });
        // Re-enqueue into BullMQ with backoff delay.
        // retryTag gives a fresh jobId — see the comment in the pre-check
        // rate-limit branch above for why re-adding the same jobId here
        // (while this job is still active) would be silently dropped.
        // v2.2: the tag is deterministic (`rl${retryAt.getTime()}`),
        // matching the post's persisted scheduledAt — see cancelJobPostsByIds.
        await enqueuePost(
          redis,
          {
            postId: post.id,
            jobId: post.jobId,
            accountId: post.accountId,
            pageId: account.fbPageId,
            postType: post.postType,
          },
          retryAt,
          `rl${retryAt.getTime()}`
        );
        throw new RateLimitExceededError(
          account.fbPageId,
          `FB rate limit (code ${err.code}): ${err.message}`
        );
      }

      // Regular Graph API error — let BullMQ retry
      throw err;
    }

    // Non-Facebook error
    throw err;
  }

  // ── 6. Mark post as posted ─────────────────────────────
  await prisma.post.update({
    where: { id: postId },
    data: {
      status: "posted",
      postedAt: new Date(),
      fbPostId: fbPostId ?? null,
    },
  });

  const duration = Date.now() - startTime;
  console.log(
    `[process] Post ${postId} (${postType}) published → ${fbPostId} in ${duration}ms`
  );

  // ── 7. Handle optional comment (failure never fails post) ─
  // The CSV `comment` column is now tracked as a ScheduledComment row
  // (source='immediate', delay 0) fired through the comment queue. This
  // gives it the same attempt tracking, retry and missing-comment
  // detection as every other comment, while the legacy Post.commentPosted /
  // commentError fields stay in sync (worker marks them on success/failure).
  if (post.comment && post.comment.trim() && fbPostId) {
    try {
      const sc = await prisma.scheduledComment.create({
        data: {
          postId,
          message: post.comment.trim(),
          delayMinutes: 0,
          source: "immediate",
          accountId: post.accountId,
          fbPostId,
          status: "pending",
        },
      });
      await enqueueComment(
        redis,
        { scheduledCommentId: sc.id, fbPostId },
        new Date() // fire immediately
      );
      console.log(`[process] Post ${postId} immediate comment queued (${sc.id})`);
    } catch (err) {
      // Queueing failed — record it so the comment shows up on the
      // Missing Comments page instead of silently vanishing.
      const errMsg = err instanceof Error ? err.message : String(err);
      await prisma.post.update({
        where: { id: postId },
        data: {
          commentPosted: false,
          commentError: `Failed to queue comment: ${errMsg}`.substring(0, 500),
        },
      });
      console.warn(`[process] Post ${postId} comment could not be queued: ${errMsg}`);
    }
  }

  // ── 8. Schedule optional delayed comments (each independent) ─
  // Each comment fires its own BullMQ delayed job. If the row wasn't
  // created (user left the CSV column blank), nothing runs here —
  // that's the "auto-skip when nobody set it" behavior.
  if (fbPostId) {
    const scheduledComments = await prisma.scheduledComment.findMany({
      where: { postId, status: "pending", source: "csv_delayed" },
    });
    for (const sc of scheduledComments) {
      const fireAt = new Date(Date.now() + sc.delayMinutes * 60_000);
      try {
        // Persist the fbPostId on the row (retry safety — each comment
        // job carries its own account + published post id binding).
        await prisma.scheduledComment.update({
          where: { id: sc.id },
          data: { fbPostId, accountId: post.accountId },
        });
        await enqueueComment(redis, { scheduledCommentId: sc.id, fbPostId }, fireAt);
      } catch (err) {
        console.warn(
          `[process] Failed to schedule comment ${sc.id} for post ${postId}: ${err}`
        );
      }
    }
  }

  // ── 9. Update job counters ──────────────────────────────
  await updateJobCounters(post.jobId);

  // ── 10. Check if job is complete ─────────────────────────
  await checkJobCompletion(post.jobId);
}

/**
 * Recalculate and update a job's completedPosts and failedPosts counts.
 */
async function updateJobCounters(jobId: string): Promise<void> {
  const counts = await prisma.post.groupBy({
    by: ["status"],
    where: { jobId },
    _count: true,
  });

  const completed = counts.find((c) => c.status === "posted")?._count ?? 0;
  const failed = counts.find((c) => c.status === "failed")?._count ?? 0;

  await prisma.job.update({
    where: { id: jobId },
    data: { completedPosts: completed, failedPosts: failed },
  });
}

/**
 * Check if all posts in a job are done. If so, mark job as completed.
 *
 * v2.2: "paused" counts as NOT done. Without this, a post that was
 * mid-flight when the user clicked pause could land moments later, run
 * this check, see zero pending/scheduled/posting rows (the rest are all
 * "paused") and wrongly mark the job completed — which would make it
 * un-resumable with posts stuck in "paused" forever.
 */
async function checkJobCompletion(jobId: string): Promise<void> {
  const pendingCount = await prisma.post.count({
    where: {
      jobId,
      status: { in: ["pending", "scheduled", "posting", "paused"] },
    },
  });

  if (pendingCount === 0) {
    const failedCount = await prisma.post.count({
      where: { jobId, status: "failed" },
    });
    // If there are failed posts but no pending ones, job is still completed
    // (not "failed" — partial completion is a normal outcome)
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: "completed",
        completedAt: new Date(),
      },
    });
    console.log(
      `[process] Job ${jobId} completed (failed: ${failedCount})`
    );
  }
}
