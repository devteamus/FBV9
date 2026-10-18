/**
 * POST /api/comments/[id]/mark-published — manual resolution for a
 * comment whose outcome is uncertain (needs_review).
 *
 * The user has verified (by opening the post on Facebook) that the
 * comment actually made it there — this records that fact without making
 * any Graph API call and without publishing anything.
 *
 * Body: { fbCommentId?: string } — the comment id seen on Facebook, if
 * the user copied it. Purely optional bookkeeping.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, AuthError, ValidationError } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireComment } from "@/lib/ownership";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { sub: userId } = await getSession();
    const { id } = await params;

    const comment = await requireComment(userId, id);

    if (comment.status === "published") {
      return NextResponse.json(
        { error: "This comment is already marked published" },
        { status: 409 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const fbCommentId = (body as { fbCommentId?: unknown })?.fbCommentId;
    if (
      fbCommentId !== undefined &&
      fbCommentId !== null &&
      (typeof fbCommentId !== "string" || fbCommentId.length > 100)
    ) {
      throw new ValidationError("Invalid fbCommentId");
    }

    await prisma.scheduledComment.update({
      where: { id: comment.id },
      data: {
        status: "published",
        postedAt: comment.postedAt ?? new Date(),
        fbCommentId:
          typeof fbCommentId === "string" && fbCommentId.trim()
            ? fbCommentId.trim()
            : comment.fbCommentId,
        errorMessage: null,
      },
    });

    // Keep the legacy immediate-comment fields in sync so the existing
    // Jobs UI keeps showing the right thing.
    if (comment.source === "immediate") {
      await prisma.post.update({
        where: { id: comment.postId },
        data: { commentPosted: true, commentError: null },
      });
    }

    return NextResponse.json({ success: true, commentId: comment.id });
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
    console.error("[comments:mark-published]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
