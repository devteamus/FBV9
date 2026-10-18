/**
 * POST /api/comments/[id]/publish — retry / publish a single tracked
 * comment (Feature 4).
 *
 * Body: { message?: string } — optional edited comment text.
 *
 * The parent post is never republished; only the comment is attempted.
 * Comments already published or skipped are refused (409). The worker
 * re-verifies on retries so a previously-uncertain comment is never
 * duplicated.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, AuthError, ValidationError } from "@/lib/auth";
import { requireComment } from "@/lib/ownership";
import { prisma } from "@/lib/prisma";
import { sanitizeMessage, enqueueCommentRetry } from "@/lib/comment-actions";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { sub: userId } = await getSession();
    const { id } = await params;

    const comment = await requireComment(userId, id);

    const post = await prisma.post.findUnique({
      where: { id: comment.postId },
    });
    if (!post) {
      return NextResponse.json({ error: "Parent post not found" }, { status: 404 });
    }

    const body = await request.json().catch(() => ({}));
    const rawMessage = (body as { message?: unknown })?.message;
    const messageOverride =
      rawMessage !== undefined && rawMessage !== null
        ? sanitizeMessage(rawMessage)
        : undefined;

    const result = await enqueueCommentRetry(comment, post, messageOverride);

    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof Error && err.name === "NotFoundError") {
      return NextResponse.json({ error: "Comment not found" }, { status: 404 });
    }
    console.error("[comments:publish]", err);
    return NextResponse.json(
      { error: "Failed to queue the comment — please try again" },
      { status: 500 }
    );
  }
}
