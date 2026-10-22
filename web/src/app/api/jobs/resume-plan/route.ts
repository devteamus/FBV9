/**
 * GET /api/jobs/resume-plan — next-due time of every paused job.
 *
 * Pausing keeps each post's original scheduledAt, so MIN(scheduledAt) of a
 * paused job's paused posts is the moment its next post was originally due.
 * The Jobs page uses this to resume all jobs while keeping the original
 * stagger between accounts (see Resume all).
 */

import { NextResponse } from "next/server";
import { getSession, AuthError } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const { sub: userId } = await getSession();
    const groups = await prisma.post.groupBy({
      by: ["jobId"],
      where: { userId, status: "paused", scheduledAt: { not: null } },
      _min: { scheduledAt: true },
    });
    return NextResponse.json(
      groups
        .filter((g) => g._min.scheduledAt)
        .map((g) => ({ jobId: g.jobId, nextDue: g._min.scheduledAt!.toISOString() }))
    );
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[jobs:resume-plan]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
