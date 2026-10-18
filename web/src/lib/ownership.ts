/**
 * Data isolation / ownership enforcement helpers (§7A).
 *
 * EVERY query for Account, Job, or Post MUST be scoped by userId.
 * These helpers enforce that at a single point — a forgotten check
 * in any individual route is a full cross-tenant leak.
 *
 * The userId always comes from the verified JWT session, never from
 * request body/query params (§7B).
 */

import { prisma } from "./prisma";
import { NotFoundError } from "./auth";

/**
 * Require an Account that belongs to the authenticated user.
 * Returns the account with token field excluded (never sent to browser, §7B).
 */
export async function requireAccount(userId: string, accountId: string) {
  const account = await prisma.account.findFirst({
    where: { id: accountId, userId },
    select: {
      id: true,
      userId: true,
      name: true,
      fbPageId: true,
      fbApiVersion: true,
      isActive: true,
      createdAt: true,
      _count: { select: { jobs: true } },
    },
  });
  if (!account) throw new NotFoundError("Account not found");
  return account;
}

/**
 * Require a Job that belongs to the authenticated user.
 */
export async function requireJob(userId: string, jobId: string) {
  const job = await prisma.job.findFirst({
    where: { id: jobId, userId },
    include: {
      account: { select: { id: true, name: true } },
    },
  });
  if (!job) throw new NotFoundError("Job not found");
  return job;
}

/**
 * Require a Job (ownership check) and return just the job without include.
 * Used for mutations where we don't need the account relation.
 */
export async function requireJobOwned(userId: string, jobId: string) {
  const job = await prisma.job.findFirst({
    where: { id: jobId, userId },
  });
  if (!job) throw new NotFoundError("Job not found");
  return job;
}

/**
 * Require a Post that belongs to the authenticated user.
 * Used by the post-preview, comment-history and comment-publish routes.
 */
export async function requirePost(userId: string, postId: string) {
  const post = await prisma.post.findFirst({
    where: { id: postId, userId },
  });
  if (!post) throw new NotFoundError("Post not found");
  return post;
}

/**
 * Require a ScheduledComment that belongs to the authenticated user
 * (via its parent post). Returns the comment with post + account info.
 */
export async function requireComment(userId: string, commentId: string) {
  const comment = await prisma.scheduledComment.findFirst({
    where: { id: commentId, post: { userId } },
    include: {
      post: { select: { id: true, accountId: true, fbPostId: true, status: true } },
    },
  });
  if (!comment) throw new NotFoundError("Comment not found");
  return comment;
}

/**
 * Serialize a ScheduledComment (unified comment job) for API response.
 * Never includes anything token-related (comments only reference ids).
 */
export function serializeCommentJob(
  sc: {
    id: string;
    postId: string;
    message: string;
    delayMinutes: number;
    source: string;
    accountId: string | null;
    fbPostId: string | null;
    status: string;
    fbCommentId: string | null;
    errorMessage: string | null;
    attemptCount: number;
    lastAttemptAt: Date | null;
    postedAt: Date | null;
    createdAt: Date;
  }
) {
  return {
    id: sc.id,
    postId: sc.postId,
    message: sc.message,
    delayMinutes: sc.delayMinutes,
    source: sc.source, // csv_delayed | immediate
    accountId: sc.accountId,
    fbPostId: sc.fbPostId,
    status: sc.status, // pending|processing|published|failed|skipped|needs_review
    fbCommentId: sc.fbCommentId,
    errorMessage: sc.errorMessage,
    attemptCount: sc.attemptCount,
    lastAttemptAt: sc.lastAttemptAt?.toISOString() ?? null,
    postedAt: sc.postedAt?.toISOString() ?? null,
    createdAt: sc.createdAt.toISOString(),
    isAutomation: true, // every tracked row was published by this app
  };
}

/**
 * Serialize an Account for API response.
 * NEVER includes fbPageAccessToken (§7B — not even truncated).
 */
export function serializeAccount(a: {
  id: string;
  name: string;
  fbPageId: string;
  fbApiVersion: string;
  isActive: boolean;
  createdAt: Date;
  fbPagePictureUrl?: string | null;
  _count?: { jobs: number };
}) {
  return {
    id: a.id,
    name: a.name,
    fbPageId: a.fbPageId,
    fbApiVersion: a.fbApiVersion,
    isActive: a.isActive,
    createdAt: a.createdAt.toISOString(),
    fbPagePictureUrl: a.fbPagePictureUrl ?? null,
    jobCount: a._count?.jobs ?? 0,
  };
}

/**
 * Serialize a Job for API response.
 */
export function serializeJob(j: {
  id: string;
  accountId: string;
  account?: { id: string; name: string } | null;
  originalFilename: string;
  status: string;
  intervalMinutes: number;
  totalPosts: number;
  completedPosts: number;
  failedPosts: number;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  csvDeleted: boolean;
  errorMessage: string | null;
}) {
  return {
    id: j.id,
    accountId: j.accountId,
    accountName: j.account?.name ?? null,
    originalFilename: j.originalFilename,
    status: j.status,
    intervalMinutes: j.intervalMinutes,
    totalPosts: j.totalPosts,
    completedPosts: j.completedPosts,
    failedPosts: j.failedPosts,
    createdAt: j.createdAt.toISOString(),
    startedAt: j.startedAt?.toISOString() ?? null,
    completedAt: j.completedAt?.toISOString() ?? null,
    csvDeleted: j.csvDeleted,
    errorMessage: j.errorMessage,
  };
}

/**
 * Serialize a Post for API response.
 */
export function serializePost(p: {
  id: string;
  jobId: string;
  accountId: string;
  caption: string;
  mediaUrl: string;
  postType: string;
  comment: string | null;
  commentPosted: boolean;
  commentError: string | null;
  status: string;
  scheduledAt: Date | null;
  postedAt: Date | null;
  fbPostId: string | null;
  errorMessage: string | null;
  retryCount: number;
  scheduledComments?: Array<{
    id: string;
    message: string;
    delayMinutes: number;
    status: string;
    errorMessage: string | null;
  }>;
}) {
  return {
    id: p.id,
    jobId: p.jobId,
    accountId: p.accountId,
    caption: p.caption.length > 120
      ? p.caption.substring(0, 120) + "..."
      : p.caption,
    fullCaption: p.caption,
    mediaUrl: p.mediaUrl,
    postType: p.postType,
    comment: p.comment,
    commentPosted: p.commentPosted,
    commentError: p.commentError,
    status: p.status,
    scheduledAt: p.scheduledAt?.toISOString() ?? null,
    postedAt: p.postedAt?.toISOString() ?? null,
    fbPostId: p.fbPostId,
    errorMessage: p.errorMessage,
    retryCount: p.retryCount,
    scheduledComments: (p.scheduledComments ?? []).map((sc) => ({
      id: sc.id,
      message: sc.message,
      delayMinutes: sc.delayMinutes,
      status: sc.status,
      errorMessage: sc.errorMessage,
    })),
  };
}

/**
 * Full post serialization for the Published Posts preview page —
 * includes the account context and per-post comment summary,
 * computed from the tracked ScheduledComment rows.
 */
export function serializePublishedPost(
  p: {
    id: string;
    jobId: string;
    accountId: string;
    caption: string;
    mediaUrl: string;
    postType: string;
    comment: string | null;
    commentPosted: boolean;
    commentError: string | null;
    status: string;
    scheduledAt: Date | null;
    postedAt: Date | null;
    fbPostId: string | null;
    errorMessage: string | null;
    retryCount: number;
  },
  account?: { id: string; name: string; fbPageId: string; fbPagePictureUrl: string | null } | null,
  commentSummary?: { published: number; pending: number; missing: number; total: number }
) {
  return {
    id: p.id,
    jobId: p.jobId,
    accountId: p.accountId,
    accountName: account?.name ?? null,
    accountPictureUrl: account?.fbPagePictureUrl ?? null,
    pageId: account?.fbPageId ?? null,
    caption: p.caption,
    mediaUrl: p.mediaUrl,
    postType: p.postType,
    comment: p.comment,
    status: p.status,
    scheduledAt: p.scheduledAt?.toISOString() ?? null,
    postedAt: p.postedAt?.toISOString() ?? null,
    fbPostId: p.fbPostId,
    fbLink: p.fbPostId ? `https://www.facebook.com/${p.fbPostId}` : null,
    errorMessage: p.errorMessage,
    retryCount: p.retryCount,
    // Comment summary for this post (0s when nothing was configured)
    comments: commentSummary ?? { published: 0, pending: 0, missing: 0, total: 0 },
    // Derived overall comment status for filtering/badges:
    // none | published | partial | pending | missing
    commentStatus: deriveCommentStatus(p, commentSummary),
  };
}

function deriveCommentStatus(
  p: { comment: string | null; commentPosted: boolean },
  cs?: { published: number; pending: number; missing: number; total: number }
): "none" | "published" | "partial" | "pending" | "missing" {
  const summary = cs ?? { published: 0, pending: 0, missing: 0, total: 0 };
  const total = summary.total;
  if (total === 0) return "none";
  if (summary.published === total) return "published";
  if (summary.missing > 0) return "missing";
  if (summary.published > 0 && summary.pending > 0) return "partial";
  if (summary.published === 0 && summary.pending > 0) return "pending";
  return "partial";
}
