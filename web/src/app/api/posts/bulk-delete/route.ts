/**
 * POST /api/posts/bulk-delete
 * Body: { post_ids: string[] }
 *
 * Bulk-deletes multiple already-published posts from Facebook.
 * Each post gets its own independent BullMQ delete job — one failing
 * (bad token, page removed, etc.) never blocks or affects the others.
 * Ownership-scoped: only posts belonging to the authenticated user and
 * currently in "posted" status are queued; anything else is reported
 * back as skipped rather than silently ignored.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, AuthError, ValidationError } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { enqueueDeletePost } from "@/lib/queues/helpers";

const MAX_BULK = 500;

export async function POST(request: NextRequest) {
  try {
    const { sub: userId } = await getSession();
    const body = await request.json().catch(() => ({}));
    const postIds: unknown = body?.post_ids;

    if (!Array.isArray(postIds) || postIds.length === 0) {
      throw new ValidationError("post_ids must be a non-empty array");
    }
    if (postIds.length > MAX_BULK) {
      throw new ValidationError(`Cannot delete more than ${MAX_BULK} posts at once`);
    }
    const ids = postIds.filter((x): x is string => typeof x === "string");

    // Ownership-scoped fetch — only this user's posts, only ones actually
    // eligible for deletion (posted + has an fbPostId)
    const posts = await prisma.post.findMany({
      where: {
        id: { in: ids },
        userId,
        status: "posted",
        fbPostId: { not: null },
      },
    });

    const eligibleIds = new Set(posts.map((p) => p.id));
    const skipped = ids.filter((id) => !eligibleIds.has(id));

    const redis = getRedis();
    let queued = 0;
    for (const post of posts) {
      try {
        await enqueueDeletePost(redis, {
          postId: post.id,
          fbPostId: post.fbPostId as string,
          accountId: post.accountId,
        });
        queued++;
      } catch (err) {
        console.error(`[posts:bulk-delete] failed to enqueue ${post.id}`, err);
        skipped.push(post.id);
      }
    }

    return NextResponse.json({
      success: true,
      queued,
      skipped, // ids not eligible (already deleted, not posted, or belongs to someone else) or that failed to enqueue
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("[posts:bulk-delete]", err);
    return NextResponse.json({ error: "Failed to queue bulk delete" }, { status: 500 });
  }
}
