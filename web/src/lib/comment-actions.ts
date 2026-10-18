/**
 * Comment action service — shared logic for the manual publish / retry
 * / bulk-retry / mark-published / skip endpoints (Feature 4).
 *
 * Everything here is ownership-prechecked by the calling route and only
 * manipulates ScheduledComment rows + enqueues BullMQ jobs. The worker
 * (publishCommentJob) performs the actual Graph API call and all
 * duplicate-prevention guarantees.
 */

import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { enqueueComment } from "@/lib/queues/helpers";
import { ValidationError } from "@/lib/auth";

/** Max comment length (same limit the CSV upload enforces). */
const MAX_COMMENT_LENGTH = 2000;

export function sanitizeMessage(message: unknown): string {
  if (typeof message !== "string") {
    throw new ValidationError("message must be a string");
  }
  const trimmed = message.trim();
  if (!trimmed) {
    throw new ValidationError("Comment text cannot be empty");
  }
  if (trimmed.length > MAX_COMMENT_LENGTH) {
    throw new ValidationError(`Comment is too long (max ${MAX_COMMENT_LENGTH} characters)`);
  }
  // Strip control chars (same policy as CSV import)
  return trimmed.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

export interface RetryResult {
  commentId: string;
  queued: true;
  attempt: number;
}

/**
 * Queue a publish/retry for an existing comment row.
 *
 * - Refuses to touch comments already published/skipped (§ never retry
 *   succeeded comments).
 * - Optional message override edits the comment text first (kept in sync
 *   on Post.comment for immediate comments, so the Jobs UI stays truthful).
 * - Resets the row to 'pending' and enqueues with an attempt-suffixed
 *   BullMQ jobId: double-clicking a retry button dedupes to one job,
 *   while a genuinely later retry gets its own job.
 * - Verifies the parent post is published with a Facebook post id —
 *   a comment can never (re)publish the post itself.
 */
export async function enqueueCommentRetry(
  comment: {
    id: string;
    postId: string;
    message: string;
    status: string;
    attemptCount: number;
    source: string;
  },
  post: {
    id: string;
    accountId: string;
    fbPostId: string | null;
    status: string;
    comment: string | null;
  },
  messageOverride?: string
): Promise<RetryResult> {
  if (comment.status === "published") {
    throw new ValidationError("This comment is already published — refusing to retry");
  }
  if (comment.status === "skipped") {
    throw new ValidationError(
      "This comment was skipped — publish it explicitly if you want it to go out"
    );
  }
  if (post.status !== "posted" || !post.fbPostId) {
    throw new ValidationError(
      "The parent post is not published on Facebook — there is nothing to comment on"
    );
  }

  const message = messageOverride !== undefined ? messageOverride : comment.message;

  const updated = await prisma.scheduledComment.update({
    where: { id: comment.id },
    data: {
      message,
      status: "pending",
      // NOTE: errorMessage is intentionally NOT cleared here — the worker
      // reads it to detect "previous outcome was uncertain" and then verify
      // before republishing (duplicate prevention). Terminal states clear it.
      // fbPostId binding: each comment job stays tied to the correct
      // account + published post id (§4)
      accountId: post.accountId,
      fbPostId: post.fbPostId,
    },
  });

  // Keep the legacy Post.comment text in sync when the immediate
  // comment is edited before retry (existing Jobs UI shows Post.comment).
  if (updated.source === "immediate" && messageOverride !== undefined) {
    await prisma.post.update({
      where: { id: post.id },
      data: { comment: message },
    });
  }

  const attempt = updated.attemptCount + 1;
  await enqueueComment(
    getRedis(),
    { scheduledCommentId: updated.id, fbPostId: post.fbPostId },
    new Date(),
    attempt
  );

  return { commentId: updated.id, queued: true, attempt };
}

/**
 * Find (or create) the tracked row for a post's "immediate" comment
 * slot — used by POST /api/posts/[id]/publish-comment.
 *
 * - If the post already has an immediate comment row, it is returned
 *   (retry path — the caller then goes through enqueueCommentRetry).
 * - If not, a fresh row is created with the given message (defaults to
 *   Post.comment; a user may also enter a comment for a post whose CSV
 *   had none).
 */
export async function findOrCreateImmediateComment(
  post: {
    id: string;
    accountId: string;
    fbPostId: string | null;
    status: string;
    comment: string | null;
  },
  message: string
): Promise<{ id: string; status: string; attemptCount: number; source: string; message: string; postId: string }> {
  const existing = await prisma.scheduledComment.findFirst({
    where: { postId: post.id, source: "immediate" },
    orderBy: { createdAt: "desc" },
  });

  if (existing) {
    return existing;
  }

  return prisma.scheduledComment.create({
    data: {
      postId: post.id,
      message,
      delayMinutes: 0,
      source: "immediate",
      accountId: post.accountId,
      fbPostId: post.fbPostId,
      status: "pending",
    },
  });
}
