/**
 * GET /api/posts/[id]/comments — comment history for one post
 * (Feature 3: Post Comment History).
 *
 * Returns every comment this application tracked for the post (CSV
 * immediate, CSV delayed, and any manually published retries), with its
 * text, status, timestamps, attempt count and last error. Comments made
 * by other Facebook users are NOT included — this app only tracks what
 * it published itself (we never claim knowledge we don't have).
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, AuthError } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePost, serializeCommentJob } from "@/lib/ownership";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { sub: userId } = await getSession();
    const { id } = await params;

    const post = await requirePost(userId, id);

    const comments = await prisma.scheduledComment.findMany({
      where: { postId: post.id },
      orderBy: [{ createdAt: "asc" }, { delayMinutes: "asc" }],
    });

    return NextResponse.json({
      postId: post.id,
      // Every row here was published by this application's automation.
      // External (user-made) comments are not tracked and not listed.
      comments: comments.map(serializeCommentJob),
      note:
        "Only comments published by this application are tracked. Comments made directly on Facebook by other users are not included.",
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof Error && err.name === "NotFoundError") {
      return NextResponse.json({ error: "Post not found" }, { status: 404 });
    }
    console.error("[posts:comments]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
