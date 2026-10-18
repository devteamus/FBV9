/**
 * POST /api/comments/bulk-retry — bulk retry of eligible pending/failed
 * comments across selected posts (Feature 4).
 *
 * Body: { post_ids: string[] }  (max 200)
 *
 * For each selected post (ownership-verified), every eligible comment is
 * queued for retry:
 *   - tracked rows in failed / needs_review status
 *   - tracked rows pending but overdue (expected fire time + 5 min passed)
 *   - tracked rows stuck in processing (>10 min)
 *   - the immediate-comment slot when the post has a configured comment
 *     but no immediate row at all (crash edge) — a row is created
 *
 * Never touched:
 *   - comments already published or skipped (§ do not retry succeeded)
 *   - the original posts themselves (§ never republish the post)
 *
 * Response: per-post results + per-comment details, so the UI can show
 * exactly what succeeded and what was skipped with a reason.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, AuthError, ValidationError } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { enqueueComment } from "@/lib/queues/helpers";

const MAX_BULK = 200;
const PENDING_GRACE_MS = 5 * 60 * 1000; // overdue pending threshold
const PROCESSING_STALE_MS = 10 * 60 * 1000; // stuck processing threshold

interface PostResult {
  postId: string;
  queued: number;
  skipped: number;
  details: Array<{
    commentId: string | null;
    text: string;
    status: "queued" | "skipped";
    reason?: string;
  }>;
}

export async function POST(request: NextRequest) {
  try {
    const { sub: userId } = await getSession();
    const body = await request.json().catch(() => ({}));
    const postIds: unknown = (body as { post_ids?: unknown })?.post_ids;

    if (!Array.isArray(postIds) || postIds.length === 0) {
      throw new ValidationError("post_ids must be a non-empty array");
    }
    if (postIds.length > MAX_BULK) {
      throw new ValidationError(`Cannot retry more than ${MAX_BULK} posts at once`);
    }
    const ids = postIds.filter((x): x is string => typeof x === "string");

    // ── Ownership-scoped fetch: published posts with FB ids only ──
    const posts = await prisma.post.findMany({
      where: {
        id: { in: ids },
        userId,
        status: "posted",
        fbPostId: { not: null },
      },
      select: {
        id: true,
        accountId: true,
        fbPostId: true,
        comment: true,
        commentPosted: true,
        postedAt: true,
      },
    });
    const postMap = new Map(posts.map((p) => [p.id, p]));

    const redis = getRedis();
    const results: PostResult[] = [];
    const errors: string[] = [];

    for (const postId of ids) {
      const post = postMap.get(postId);
      if (!post) {
        results.push({
          postId,
          queued: 0,
          skipped: 1,
          details: [
            {
              commentId: null,
              text: "",
              status: "skipped",
              reason: "Not found, not published, or not yours",
            },
          ],
        });
        continue;
      }

      const details: PostResult["details"] = [];
      let queued = 0;
      let skipped = 0;

      // ── Eligible tracked comment rows ───────────────────────
      const comments = await prisma.scheduledComment.findMany({
        where: { postId },
        orderBy: { createdAt: "asc" },
      });

      for (const sc of comments) {
        if (sc.status === "published") {
          skipped++;
          details.push({
            commentId: sc.id,
            text: sc.message,
            status: "skipped",
            reason: "Already published",
          });
          continue;
        }
        if (sc.status === "skipped") {
          skipped++;
          details.push({
            commentId: sc.id,
            text: sc.message,
            status: "skipped",
            reason: "Manually skipped",
          });
          continue;
        }
        if (sc.status === "processing") {
          const stale =
            !sc.lastAttemptAt ||
            Date.now() - sc.lastAttemptAt.getTime() > PROCESSING_STALE_MS;
          if (!stale) {
            skipped++;
            details.push({
              commentId: sc.id,
              text: sc.message,
              status: "skipped",
              reason: "Currently being published",
            });
            continue;
          }
          // stale processing → fall through and retry (worker guard
          // re-checks staleness atomically before publishing)
        }
        if (sc.status === "pending") {
          // Only retry comments that are actually overdue
          const expectedFire =
            (post.postedAt?.getTime() ?? Date.now()) + sc.delayMinutes * 60_000;
          const overdue = Date.now() - expectedFire > PENDING_GRACE_MS;
          if (!overdue) {
            skipped++;
            details.push({
              commentId: sc.id,
              text: sc.message,
              status: "skipped",
              reason: "Not due yet (waiting for its scheduled delay)",
            });
            continue;
          }
        }

        // Eligible (failed / needs_review / overdue pending / stale
        // processing) → reset + enqueue with an attempt-suffixed,
        // double-submit-proof jobId.
        // errorMessage is intentionally NOT cleared — the worker reads it
        // to detect uncertain previous outcomes and verify before
        // republishing (duplicate prevention).
        try {
          await prisma.scheduledComment.update({
            where: { id: sc.id },
            data: {
              status: "pending",
              accountId: post.accountId,
              fbPostId: post.fbPostId,
            },
          });
          const attempt = sc.attemptCount + 1;
          await enqueueComment(
            redis,
            { scheduledCommentId: sc.id, fbPostId: post.fbPostId as string },
            new Date(),
            attempt
          );
          queued++;
          details.push({
            commentId: sc.id,
            text: sc.message,
            status: "queued",
          });
        } catch (err) {
          skipped++;
          const reason =
            err instanceof Error ? err.message : "Failed to queue";
          details.push({ commentId: sc.id, text: sc.message, status: "skipped", reason });
          errors.push(`Post ${postId}, comment ${sc.id}: ${reason}`);
        }
      }

      // ── Crash edge: configured immediate comment with no row ──
      const hasImmediateRow = comments.some((sc) => sc.source === "immediate");
      if (!hasImmediateRow && post.comment && post.comment.trim() && !post.commentPosted) {
        try {
          const sc = await prisma.scheduledComment.create({
            data: {
              postId: post.id,
              message: post.comment.trim(),
              delayMinutes: 0,
              source: "immediate",
              accountId: post.accountId,
              fbPostId: post.fbPostId,
              status: "pending",
            },
          });
          await enqueueComment(
            redis,
            { scheduledCommentId: sc.id, fbPostId: post.fbPostId as string },
            new Date()
          );
          queued++;
          details.push({
            commentId: sc.id,
            text: sc.message,
            status: "queued",
            reason: "Recovered missing immediate comment",
          });
        } catch (err) {
          skipped++;
          const reason =
            err instanceof Error ? err.message : "Failed to queue";
          details.push({ commentId: null, text: post.comment, status: "skipped", reason });
          errors.push(`Post ${postId} (immediate): ${reason}`);
        }
      }

      results.push({ postId, queued, skipped, details });
    }

    const totalQueued = results.reduce((acc, r) => acc + r.queued, 0);
    const totalSkipped = results.reduce((acc, r) => acc + r.skipped, 0);

    return NextResponse.json({
      success: true,
      totalQueued,
      totalSkipped,
      results,
      errors, // non-fatal enqueue errors, surfaced for debugging
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[comments:bulk-retry]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
