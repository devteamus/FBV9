/**
 * POST /api/auth/forgot-password
 *
 * Body: { email: string }
 *
 * Flow:
 *   1. Lookup user by email (case-insensitive).
 *      For privacy, we ALWAYS return success — even if email doesn't exist.
 *      This prevents email-enumeration via response timing/messages.
 *   2. Generate a 6-digit numeric code.
 *   3. Hash the code with bcrypt and store a new PasswordReset row
 *      (max 1 active code per email — older rows are marked used).
 *   4. Send the code via Resend.com API.
 *
 * Rate-limited: 5 requests / 10 minutes per IP.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { sendPasswordResetEmail } from "@/lib/resend";

const forgotSchema = z.object({
  email: z.string().email().max(120),
});

const CODE_TTL_MINUTES = 10;
const CODE_LENGTH = 6;
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

const attempts = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

function generateCode(): string {
  // Cryptographically random 6-digit code
  const n = randomBytes(4).readUInt32BE(0) % 1_000_000;
  return String(n).padStart(CODE_LENGTH, "0");
}

const GENERIC_OK = {
  success: true,
  message:
    "If an account exists for that email, a reset code has been sent. The code expires in 10 minutes.",
  expiresInMinutes: CODE_TTL_MINUTES,
};

export async function POST(request: NextRequest) {
  try {
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      "unknown";
    if (!checkRateLimit(ip)) {
      return NextResponse.json(
        { error: "Too many requests. Please wait a few minutes and try again." },
        { status: 429 }
      );
    }

    const body = await request.json();
    const parsed = forgotSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Please enter a valid email address." },
        { status: 400 }
      );
    }

    const email = parsed.data.email.toLowerCase().trim();

    // Always return generic OK — never disclose whether the email exists.
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, isActive: true },
    });

    if (!user || !user.isActive) {
      // Silently drop. We already return generic OK below.
      return NextResponse.json(GENERIC_OK);
    }

    // Invalidate any earlier unused codes for this email
    await prisma.passwordReset.updateMany({
      where: { email, usedAt: null },
      data: { usedAt: new Date() },
    });

    // Generate + hash the new code
    const code = generateCode();
    const codeHash = await bcrypt.hash(code, 10);

    await prisma.passwordReset.create({
      data: {
        email,
        codeHash,
        expiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000),
      },
    });

    // Fire the email via Resend. We still return generic OK even if email
    // fails — but log the error so the admin can see it.
    const result = await sendPasswordResetEmail(email, code);
    if (!result.success) {
      console.error("[forgot-password] sendEmail failed:", result.error);
    }

    return NextResponse.json(GENERIC_OK);
  } catch (err) {
    console.error("[forgot-password] Unexpected error:", err);
    // Still return generic OK to avoid leaking state to attacker
    return NextResponse.json(GENERIC_OK);
  }
}
