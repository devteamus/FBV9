/**
 * GET /api/jobs/[id]/posts — list posts in a job
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, AuthError } from "@/lib/auth";
import { requireJob, serializePost } from "@/lib/ownership";
import { prisma } from "@/lib/prisma";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { sub: userId } = await getSession();
    const { id } = await params;

    // Ownership check
    await requireJob(userId, id);

    // Pagination: a 10,000-row job must not be serialized in one response
    // (tens of MB of JSON — hangs the browser and pressures the 352 MB
    // web container). Default page = 1000 posts, max 2000.
    const sp = request.nextUrl.searchParams;
    const limit = Math.min(2000, Math.max(1, parseInt(sp.get("limit") || "1000", 10) || 1000));
    const offset = Math.max(0, parseInt(sp.get("offset") || "0", 10) || 0);

    const posts = await prisma.post.findMany({
      where: { jobId: id },
      skip: offset,
      take: limit,
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
