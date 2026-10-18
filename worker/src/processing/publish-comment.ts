/**
 * Unified comment publishing — the single code path every comment goes
 * through, no matter where it was triggered from:
 *
 *   - CSV `comment` column (immediate, delay 0)   → enqueued by process-post
 *   - CSV `comment_2`/`comment_3` (delayed)       → enqueued by process-post
 *   - Manual publish / retry from the dashboard   → enqueued by web API
 *   - Bulk retry (missing comments page)          → enqueued by web API
 *
 * Guarantees (§3, §4):
 *  1. Atomic status guard — only one worker can move a comment from a
 *     processable state to 'processing' (Postgres-level idempotency,
 *     same pattern as processPostJob). Prevents concurrent duplicate
 *     comment publishing even if the same job is delivered twice.
 *  2. Never republishes the parent post — only the comment.
 *  3. Never retries a comment that already succeeded ('published' rows
 *     are skipped outright).
 *  4. Duplicate prevention on retries: before a retry, the post's existing
 *     comments are fetched from Facebook and matched by exact text. If our
 *     comment is already there, the row is marked published with the real
 *     fbCommentId instead of posting a duplicate.
 *  5. Uncertain outcomes (network error / timeout — the request may have
 *     succeeded but the response was lost) are flagged 'needs_review'
 *     rather than blindly retried.
 *  6. Per-page rate limit respected (same Redis token bucket as posts).
 *  7. The parent post MUST be published and belong to the decrypted
 *     account — the page token used is the token of the account stored
 *     on the comment's own post row.
 */

import { prisma } from "../lib/prisma.js";
import { decrypt } from "../lib/encryption.js";
import { FacebookPoster, FacebookAPIError } from "../fb/client.js";
import { checkRateLimit } from "../rate-limiter/per-page.js";
import { getRedis } from "../lib/redis.js";
import { enqueueComment } from "../queues/helpers.js";

/** Statuses a worker may pick up and (re)publish from. */
export const PUBLISHABLE_STATUSES = ["pending", "failed", "needs_review"] as const;

/** How long a 'processing' row is considered owned by a live attempt. */
const PROCESSING_STALE_MS = 10 * 60 * 1000; // 10 minutes

/** FB error codes that mean "rate limited" (same set as process-post). */
const FB_RATE_LIMIT_CODES = ["4", "80004", "368", "613"];

/** FB error codes that mean the target object no longer exists. */
const FB_GONE_CODES = ["100"]; // non-existing object id (post deleted)

export class CommentSkipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommentSkipError";
  }
}

/**
 * Publish (or retry) a single tracked comment.
 * Throws CommentSkipError for conditions that are expected and should not
 * be retried (row gone, parent post not published, already published...).
 */
export async function publishCommentJob(scheduledCommentId: string): Promise<void> {
  // ── 1. Load the comment with its post + account ────────────
  const sc = await prisma.scheduledComment.findUnique({
    where: { id: scheduledCommentId },
    include: { post: { include: { account: true } } },
  });
  if (!sc) {
    throw new CommentSkipError(`Comment ${scheduledCommentId} not found`);
  }

  const post = sc.post;

  // Already succeeded — NEVER retry (§4 "do not retry succeeded comments").
  if (sc.status === "published" || sc.status === "skipped") {
    return;
  }

  // ── 2. Parent post must be live on Facebook ────────────────
  if (post.status !== "posted" || !post.fbPostId) {
    if (post.status === "deleted") {
      await prisma.scheduledComment.update({
        where: { id: sc.id },
        data: {
          status: "skipped",
          errorMessage: "Parent post was deleted from Facebook — comment skipped",
        },
      });
      throw new CommentSkipError("Parent post deleted — comment skipped");
    }
    if (post.status === "failed") {
      await prisma.scheduledComment.update({
        where: { id: sc.id },
        data: {
          status: "skipped",
          errorMessage: "Parent post failed to publish — comment skipped",
        },
      });
      throw new CommentSkipError("Parent post failed — comment skipped");
    }
    throw new CommentSkipError(
      `Parent post is '${post.status}' — not eligible for commenting yet`
    );
  }

  // The comment's stored account must match the post's account — each
  // comment job is bound to the correct account + published post id (§4).
  if (sc.accountId && sc.accountId !== post.accountId) {
    await prisma.scheduledComment.update({
      where: { id: sc.id },
      data: {
        status: "needs_review",
        errorMessage: `Data integrity error: comment account (${sc.accountId}) does not match post account (${post.accountId}) — please review manually`,
      },
    });
    throw new CommentSkipError("Comment/post account mismatch — flagged for review");
  }

  const fbPostId = sc.fbPostId ?? post.fbPostId;
  const account = post.account;
  if (!account || !account.isActive) {
    await prisma.scheduledComment.update({
      where: { id: sc.id },
      data: {
        status: "failed",
        errorMessage: "Account is deactivated or not found",
      },
    });
    throw new CommentSkipError("Account deactivated — comment failed");
  }

  // ── 3. Atomic status guard (§3 idempotency) ────────────────
  // Only proceed if the row is still in a publishable state, OR is a
  // stale 'processing' row (a worker died mid-attempt >10 min ago).
  const staleCutoff = new Date(Date.now() - PROCESSING_STALE_MS);
  const guard = await prisma.scheduledComment.updateMany({
    where: {
      id: sc.id,
      OR: [
        { status: { in: [...PUBLISHABLE_STATUSES] } },
        { status: "processing", lastAttemptAt: { lt: staleCutoff } },
      ],
    },
    data: { status: "processing", lastAttemptAt: new Date() },
  });
  if (guard.count === 0) {
    throw new CommentSkipError(
      `Comment ${sc.id} is '${sc.status}' (not publishable) — skipped`
    );
  }

  const redis = getRedis();

  // ── 4. Per-page rate limit (same bucket as posts, §3) ──────
  const rateResult = await checkRateLimit(redis, account.fbPageId);
  if (!rateResult.allowed) {
    await deferForRateLimit(sc.id, fbPostId);
    throw new CommentSkipError(
      `Page ${account.fbPageId} rate limited — comment rescheduled in 60s`
    );
  }

  // ── 5. A real attempt is about to happen — count it ────────
  const incremented = await prisma.scheduledComment.update({
    where: { id: sc.id },
    data: { attemptCount: { increment: 1 } },
  });
  const attemptNo = incremented.attemptCount;
  const previousError = sc.errorMessage ?? "";

  // ── 6. Decrypt the page token (worker-only, §7B/§10) ──────
  let accessToken: string;
  try {
    accessToken = await decrypt(account.fbPageAccessToken);
  } catch (err) {
    await markFailed(sc.id, post.id, sc.source, `Token decryption failed: ${
      err instanceof Error ? err.message : String(err)
    }`);
    throw new CommentSkipError("Token decryption failed");
  }

  const poster = new FacebookPoster(
    accessToken,
    account.fbPageId,
    account.fbApiVersion
  );

  // ── 7. Retry verification — prevent duplicate comments (§4) ─
  // Before a RETRY, or when the previous outcome was UNCERTAIN (the row
  // sat in needs_review — including rows backfilled by the migration for
  // posts that may have been commented mid-deploy), check whether the
  // exact comment text is already on the post. If it is, mark published
  // with the real fbCommentId instead of posting a duplicate.
  const isRetry = attemptNo > 1;
  const previousOutcomeUncertain =
    sc.status === "needs_review" || previousError.toLowerCase().includes("uncertain");

  if (isRetry || sc.status === "needs_review") {
    try {
      const existing = await poster.listComments(fbPostId);
      const match = existing.find(
        (c) =>
          (c.message ?? "").trim() === sc.message.trim() &&
          (!c.from || c.from.id === account.fbPageId) // ours, not a fan's
      );
      if (match) {
        await markPublished(sc.id, post.id, sc.source, match.id);
        console.log(
          `[comment] ${sc.id} verified as already published on ${fbPostId} (fbCommentId ${match.id}) — duplicate prevented`
        );
        return;
      }
      // Not on the post → previous attempt definitively did not land.
    } catch (err) {
      const code = err instanceof FacebookAPIError ? err.code : "network_error";
      console.warn(
        `[comment] ${sc.id} retry verification unavailable (${code}): ${err instanceof Error ? err.message : String(err)}`
      );
      if (previousOutcomeUncertain) {
        // Can't verify, can't safely repost — keep flagged for manual review.
        await prisma.scheduledComment.update({
          where: { id: sc.id },
          data: {
            status: "needs_review",
            errorMessage:
              `Outcome uncertain and verification unavailable (${code}). ` +
              `Please open the post on Facebook: if the comment is there, mark it published; otherwise retry.`,
          },
        });
        throw new CommentSkipError("Uncertain outcome — verification unavailable, kept for review");
      }
      // Previous outcome was a definitive failure (or verification simply
      // not permitted) → proceed with the publish attempt below.
    }
  }

  // ── 8. Publish ────────────────────────────────────────────
  try {
    const result = await poster.postComment(fbPostId, sc.message);
    await markPublished(sc.id, post.id, sc.source, result.id);
    console.log(
      `[comment] ${sc.id} published on ${fbPostId} (attempt ${attemptNo}) → fbCommentId ${result.id}`
    );
  } catch (err) {
    // Rate limit → revert to pending and reschedule with delay,
    // mirroring the post path (§3). Does not count as a failure.
    if (
      err instanceof FacebookAPIError &&
      FB_RATE_LIMIT_CODES.includes(err.code)
    ) {
      await deferForRateLimit(sc.id, fbPostId);
      console.warn(
        `[comment] ${sc.id} rate limited on ${account.fbPageId} — rescheduled in 60s`
      );
      return;
    }

    const msg = err instanceof Error ? err.message : String(err);
    const code = err instanceof FacebookAPIError ? err.code : "network_error";

    if (code === "network_error") {
      // Timeout / connection lost — the request MAY have gone through.
      // Flag for manual review instead of blind retry (§4).
      await prisma.scheduledComment.update({
        where: { id: sc.id },
        data: {
          status: "needs_review",
          errorMessage: `Outcome uncertain: ${msg}. The comment may already be on the post — verify before retrying.`,
        },
      });
      console.warn(`[comment] ${sc.id} uncertain outcome — flagged needs_review: ${msg}`);
      return;
    }

    if (FB_GONE_CODES.includes(code)) {
      // Target post no longer exists on Facebook.
      await prisma.scheduledComment.update({
        where: { id: sc.id },
        data: {
          status: "skipped",
          errorMessage: `Target post not found on Facebook (code ${code}) — comment skipped`,
        },
      });
      console.warn(`[comment] ${sc.id} target ${fbPostId} gone — skipped`);
      return;
    }

    await markFailed(sc.id, post.id, sc.source, msg);
    console.warn(`[comment] ${sc.id} failed (attempt ${attemptNo}): ${msg}`);
  }
}

/**
 * Revert a rate-limited comment to 'pending' and re-enqueue it 60s later
 * with an attempt-suffixed jobId (idempotent — double enqueue is a no-op).
 */
async function deferForRateLimit(scId: string, fbPostId: string): Promise<void> {
  const sc = await prisma.scheduledComment.findUnique({
    where: { id: scId },
    select: { attemptCount: true },
  });
  await prisma.scheduledComment.update({
    where: { id: scId },
    data: { status: "pending" },
  });
  const retryAt = new Date(Date.now() + 60_000);
  try {
    await enqueueComment(
      getRedis(),
      { scheduledCommentId: scId, fbPostId },
      retryAt,
      (sc?.attemptCount ?? 0) + 1
    );
  } catch (err) {
    // Enqueue failed (Redis down?) — row stays 'pending' and will show up
    // as an overdue pending comment on the Missing Comments page.
    console.error(`[comment] ${scId} failed to re-enqueue after rate limit: ${err}`);
  }
}

/**
 * Mark published + sync the legacy Post.commentPosted flag when this is
 * the immediate (CSV `comment` column) comment, so the existing Jobs UI
 * keeps working unchanged (§ "preserve existing fields/workflows").
 */
async function markPublished(
  scId: string,
  postId: string,
  source: string,
  fbCommentId: string
): Promise<void> {
  await prisma.scheduledComment.update({
    where: { id: scId },
    data: {
      status: "published",
      fbCommentId,
      postedAt: new Date(),
      errorMessage: null,
    },
  });
  if (source === "immediate") {
    await prisma.post.update({
      where: { id: postId },
      data: { commentPosted: true, commentError: null },
    });
  }
}

/** Mark failed + sync the legacy Post.commentError for immediate comments. */
async function markFailed(
  scId: string,
  postId: string,
  source: string,
  message: string
): Promise<void> {
  const trimmed = message.substring(0, 500);
  await prisma.scheduledComment.update({
    where: { id: scId },
    data: { status: "failed", errorMessage: trimmed },
  });
  if (source === "immediate") {
    await prisma.post.update({
      where: { id: postId },
      data: { commentPosted: false, commentError: trimmed },
    });
  }
}

/**
 * Boot-time recovery: any comment left in 'processing' when the worker
 * (re)started had an attempt interrupted — its outcome is unknown.
 * Flag as needs_review with a clear message instead of guessing.
 * If BullMQ re-delivers the job afterwards, the retry-verification in
 * publishCommentJob prevents a duplicate comment.
 */
export async function recoverInterruptedComments(): Promise<number> {
  const result = await prisma.scheduledComment.updateMany({
    where: { status: "processing" },
    data: {
      status: "needs_review",
      errorMessage:
        "Worker restarted while this comment was being published — outcome uncertain. " +
        "Verify on Facebook, then retry or mark it published.",
    },
  });
  return result.count;
}
