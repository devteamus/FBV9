/**
 * POST /api/posts/[id]/delete-from-facebook
 *
 * Deletes a single already-published post from Facebook.
 * Ownership-scoped by userId (§7A) — a user can only delete their own posts.
 * Does NOT call the Graph API directly from web (§10) — enqueues a BullMQ
 * job; the worker process holds the token-decrypt + Graph API call.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, AuthError } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { enqueueDeletePost } from "@/lib/queues/helpers";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { sub: userId } = await getSession();
    const { id } = await params;

    // Ownership check — post must belong to this user
    const post = await prisma.post.findFirst({
      where: { id, userId },
    });
    if (!post) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (post.status !== "posted" || !post.fbPostId) {
      return NextResponse.json(
        { error: "Only posted items with a Facebook post id can be deleted" },
        { status: 400 }
      );
    }

    const redis = getRedis();
    await enqueueDeletePost(redis, {
      postId: post.id,
      fbPostId: post.fbPostId,
      accountId: post.accountId,
    });

    return NextResponse.json({ success: true, queued: true });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[posts:delete-from-fb]", err);
    return NextResponse.json({ error: "Failed to queue delete" }, { status: 500 });
  }
}
