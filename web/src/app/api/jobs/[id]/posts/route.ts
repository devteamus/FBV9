/**
 * GET /api/jobs/[id]/posts — list posts in a job
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, AuthError } from "@/lib/auth";
import { requireJob, serializePost } from "@/lib/ownership";
import { prisma } from "@/lib/prisma";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { sub: userId } = await getSession();
    const { id } = await params;

    // Ownership check
    await requireJob(userId, id);

    const posts = await prisma.post.findMany({
      where: { jobId: id },
      // Order by csvRowIndex — preserves the user's CSV upload order
      // in the dashboard (row 1 first, row N last).
      // Previously used `createdAt asc`, but Prisma's `createMany` writes
      // all rows in a single statement with the same `now()` timestamp,
      // so createdAt cannot break ties deterministically — the dashboard
      // would display posts in random order even though they were
      // uploaded in a specific sequence.
      orderBy: { csvRowIndex: "asc" },
      include: { scheduledComments: true },
    });

    return NextResponse.json(posts.map(serializePost));
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
