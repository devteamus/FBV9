/**
 * POST /api/posts/[id]/publish-comment — Publish Comment action for a
 * post's "immediate" comment slot (Feature 4: Missing Comment Management).
 *
 * Body: { message?: string }
 *   - message optional: defaults to the post's configured CSV comment.
 *     If the post has no tracked immediate comment yet (legacy rows are
 *     backfilled by migration; this covers crash edge cases), one is
 *     created with this message.
 *
 * Safety:
 *   - Ownership-scoped (post must belong to the session user).
 *   - Post must be published with a fbPostId — the original post is
 *     NEVER republished, only the comment.
 *   - If the immediate comment is already published → 409 (duplicate
 *     prevention).
 *   - Enqueue uses an attempt-suffixed BullMQ jobId (double submit is
 *     a no-op); the worker re-verifies before publishing on retries.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, AuthError, ValidationError } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePost } from "@/lib/ownership";
import { sanitizeMessage, findOrCreateImmediateComment, enqueueCommentRetry } from "@/lib/comment-actions";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { sub: userId } = await getSession();
    const { id } = await params;

    const post = await requirePost(userId, id);

    if (post.status !== "posted" || !post.fbPostId) {
      return NextResponse.json(
        { error: "Only published posts can receive comments" },
        { status: 400 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const rawMessage = (body as { message?: unknown })?.message;

    const message =
      rawMessage !== undefined && rawMessage !== null
        ? sanitizeMessage(rawMessage)
        : post.comment?.trim();

    if (!message) {
      return NextResponse.json(
        {
          error:
            "No comment configured for this post and no message provided. Enter a comment to publish.",
        },
        { status: 400 }
      );
    }

    const comment = await findOrCreateImmediateComment(post, message);

    if (comment.status === "published") {
      return NextResponse.json(
        { error: "This post's comment is already published — nothing to do" },
        { status: 409 }
      );
    }
    if (comment.status === "processing") {
      return NextResponse.json(
        { error: "This comment is currently being published — please wait" },
        { status: 409 }
      );
    }

    const result = await enqueueCommentRetry(comment, post, message);

    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof Error && err.name === "NotFoundError") {
      return NextResponse.json({ error: "Post not found" }, { status: 404 });
    }
    console.error("[posts:publish-comment]", err);
    return NextResponse.json(
      { error: "Failed to queue the comment — please try again" },
      { status: 500 }
    );
  }
}
