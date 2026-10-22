/**
 * POST /api/comments/pause-all — Paused ALL of the user's tracked comments.
 * Used by the Jobs page "Pause all / Resume all" buttons so comments of
 * already-finished jobs stop (and restart) together with the posts.
 */

import { NextResponse } from "next/server";
import { getSession, AuthError } from "@/lib/auth";
import { getRedis } from "@/lib/redis";
import { pauseComments } from "@/lib/comment-pause";

export async function POST() {
  try {
    const { sub: userId } = await getSession();
    const count = await pauseComments(getRedis(), { post: { userId } });
    return NextResponse.json({ success: true, paused: count });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[comments:pause-all]", err);
    return NextResponse.json({ error: "Could not pause comments" }, { status: 500 });
  }
}
