/**
 * POST /api/comments/[id]/skip — dismiss a missing comment.
 *
 * Marks the comment 'skipped' so it stops appearing in the Missing
 * Comments worklist (e.g. the user decided it is no longer wanted).
 * Reversible: publishing it again from the post's comment history
 * re-activates the row.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, AuthError } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireComment } from "@/lib/ownership";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { sub: userId } = await getSession();
    const { id } = await params;

    const comment = await requireComment(userId, id);

    if (comment.status === "published") {
      return NextResponse.json(
        { error: "This comment is published and cannot be skipped" },
        { status: 409 }
      );
    }

    await prisma.scheduledComment.update({
      where: { id: comment.id },
      data: {
        status: "skipped",
        errorMessage: "Manually skipped by user",
      },
    });

    return NextResponse.json({ success: true, commentId: comment.id });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof Error && err.name === "NotFoundError") {
      return NextResponse.json({ error: "Comment not found" }, { status: 404 });
    }
    console.error("[comments:skip]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
