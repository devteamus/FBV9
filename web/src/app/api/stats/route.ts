/**
 * GET /api/stats — dashboard-level stats for authenticated user
 */

import { NextResponse } from "next/server";
import { getSession, AuthError } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const { sub: userId } = await getSession();

    const [
      totalJobs,
      totalPosts,
      posted,
      pending,
      failed,
      accountCount,
    ] = await Promise.all([
      prisma.job.count({ where: { userId } }),
      prisma.post.count({ where: { userId } }),
      prisma.post.count({ where: { userId, status: "posted" } }),
      prisma.post.count({
        where: {
          userId,
          status: { in: ["pending", "scheduled", "posting"] },
        },
      }),
      prisma.post.count({ where: { userId, status: "failed" } }),
      prisma.account.count({ where: { userId } }),
    ]);

    return NextResponse.json({
      total_jobs: totalJobs,
      total_posts: totalPosts,
      posted,
      pending,
      failed,
      account_count: accountCount,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[stats]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
