/**
 * POST /api/auth/login
 * Login by email + password.
 * Rate-limited: 10/minute per IP.
 *
 * v2 change: login is now done via EMAIL (not username).
 * The old username field is still stored on the User row for display only.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  verifyPassword,
  createToken,
  setSessionCookie,
  ValidationError,
} from "@/lib/auth";

const loginSchema = z.object({
  email: z.string().email().max(120),
  password: z.string().min(1),
});

// Simple in-memory rate limiter for login
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_MS = 60 * 1000; // 1 minute

function checkLoginRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= LOGIN_LIMIT;
}

export async function POST(request: NextRequest) {
  try {
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      "unknown";
    if (!checkLoginRateLimit(ip)) {
      return NextResponse.json(
        { error: "Too many login attempts. Try again later." },
        { status: 429 }
      );
    }

    const body = await request.json();
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors[0].message);
    }

    const { email, password } = parsed.data;
    const emailLower = email.toLowerCase().trim();

    const user = await prisma.user.findUnique({
      where: { email: emailLower },
    });
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      // Same generic error for "no such email" vs "wrong password"
      // to prevent email-enumeration attacks.
      throw new ValidationError("Invalid email or password");
    }
    if (!user.isActive) {
      throw new ValidationError("Your account has been deactivated.");
    }

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
        status: 200,
        headers: { "Set-Cookie": setSessionCookie(token) },
      }
    );
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    console.error("[login] Unexpected error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
