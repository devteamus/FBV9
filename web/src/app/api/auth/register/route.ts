/**
 * POST /api/auth/register
 * Rate-limited: 5/hour (via simple in-memory counter per §7B).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashPassword, createToken, setSessionCookie, ValidationError } from "@/lib/auth";

const registerSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(30)
    .regex(/^[a-z0-9_.-]+$/, "Username must be 3-30 chars: letters, numbers, . _ -"),
  email: z.string().email().max(120),
  password: z.string().min(8).max(128),
});

// Simple in-memory rate limiter for register (per IP)
const registerAttempts = new Map<string, { count: number; resetAt: number }>();
const REGISTER_LIMIT = 5;
const REGISTER_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function checkRegisterRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = registerAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    registerAttempts.set(ip, { count: 1, resetAt: now + REGISTER_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= REGISTER_LIMIT;
}

export async function POST(request: NextRequest) {
  try {
    // Rate limit
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    if (!checkRegisterRateLimit(ip)) {
      return NextResponse.json(
        { error: "Too many registration attempts. Try again later." },
        { status: 429 }
      );
    }

    const body = await request.json();
    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors[0].message);
    }

    const { username, email, password } = parsed.data;
    const usernameLower = username.toLowerCase();
    const emailLower = email.toLowerCase();

    // Check uniqueness
    const existing = await prisma.user.findFirst({
      where: {
        OR: [{ username: usernameLower }, { email: emailLower }],
      },
    });
    if (existing) {
      throw new ValidationError("Username or email already exists");
    }

    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: {
        username: usernameLower,
        email: emailLower,
        passwordHash,
      },
    });

    const token = await createToken(user.id);

    return new NextResponse(
      JSON.stringify({
        success: true,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          isActive: user.isActive,
          createdAt: user.createdAt.toISOString(),
        },
      }),
      {
        status: 201,
        headers: { "Set-Cookie": setSessionCookie(token) },
      }
    );
  } catch (err) {
    return handleError(err);
  }
}

function handleError(err: unknown) {
  if (err instanceof ValidationError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  // Prisma unique constraint violation
  if (
    err &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code: string }).code === "P2002"
  ) {
    return NextResponse.json(
      { error: "Username or email already exists" },
      { status: 409 }
    );
  }
  console.error("[register] Unexpected error:", err);
  return NextResponse.json(
    { error: "Internal server error" },
    { status: 500 }
  );
}
