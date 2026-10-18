/**
 * GET /api/auth/me
 * Returns current authenticated user info.
 */

import { NextResponse } from "next/server";
import { getSession, AuthError } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const { sub: userId } = await getSession();
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        email: true,
        isActive: true,
        createdAt: true,
        _count: { select: { accounts: true, jobs: true } },
      },
    });
    if (!user) throw new AuthError("User not found", 404);

    return NextResponse.json({
      id: user.id,
      username: user.username,
      email: user.email,
      isActive: user.isActive,
      createdAt: user.createdAt.toISOString(),
      accountCount: user._count.accounts,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[me] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
