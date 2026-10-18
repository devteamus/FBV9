/**
 * GET /api/jobs — list user's jobs (optional ?account_id filter)
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, AuthError } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { serializeJob } from "@/lib/ownership";

export async function GET(request: NextRequest) {
  try {
    const { sub: userId } = await getSession();
    const { searchParams } = new URL(request.url);
    const accountId = searchParams.get("account_id");

    const where: Record<string, unknown> = { userId };
    if (accountId) where.accountId = accountId;

    const jobs = await prisma.job.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        account: { select: { id: true, name: true } },
      },
    });

    return NextResponse.json(jobs.map(serializeJob));
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[jobs:list]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
