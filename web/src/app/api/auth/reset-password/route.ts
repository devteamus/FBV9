/**
 * POST /api/auth/reset-password
 *
 * Body: { email: string; code: string; newPassword: string }
 *
 * Flow:
 *   1. Validate input shape.
 *   2. Look up the latest unused, unexpired PasswordReset row for that email.
 *   3. Lock the row (via unique id lookup) so concurrent calls can't double-spend.
 *   4. bcrypt.compare the code; increment attempts on mismatch.
 *      After 5 failed attempts, invalidate the row.
 *   5. On success, mark the row used and update the user's passwordHash.
 *   6. Also invalidate ALL other reset rows for that email.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/auth";

const resetSchema = z.object({
  email: z.string().email().max(120),
  code: z.string().regex(/^\d{6}$/, "Code must be exactly 6 digits"),
  newPassword: z.string().min(8).max(128),
});

const MAX_ATTEMPTS = 5;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = resetSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors[0].message },
        { status: 400 }
      );
    }

    const { email, code, newPassword } = parsed.data;
    const emailLower = email.toLowerCase().trim();

    const reset = await prisma.passwordReset.findFirst({
      where: {
        email: emailLower,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });

    if (!reset) {
      return NextResponse.json(
        {
          error:
            "No active reset code found. Please request a new code, or the previous code may have expired.",
        },
        { status: 400 }
      );
    }

    // Too many wrong attempts on this code
    if (reset.attempts >= MAX_ATTEMPTS) {
      await prisma.passwordReset.update({
        where: { id: reset.id },
        data: { usedAt: new Date() },
      });
      return NextResponse.json(
        { error: "Too many incorrect attempts. Please request a new code." },
        { status: 400 }
      );
    }

    const codeMatches = await bcrypt.compare(code, reset.codeHash);

    if (!codeMatches) {
      // Increment attempts
      const updated = await prisma.passwordReset.update({
        where: { id: reset.id },
        data: { attempts: { increment: 1 } },
      });

      const remaining = Math.max(0, MAX_ATTEMPTS - updated.attempts);
      return NextResponse.json(
        {
          error: `Invalid code. ${remaining} attempt${
            remaining === 1 ? "" : "s"
          } remaining.`,
        },
        { status: 400 }
      );
    }

    // Code matched — look up the user, update password
    const user = await prisma.user.findUnique({
      where: { email: emailLower },
      select: { id: true },
    });
    if (!user) {
      return NextResponse.json(
        { error: "User not found." },
        { status: 404 }
      );
    }

    const newHash = await hashPassword(newPassword);

    // Atomic-ish: mark row used + update password
    await prisma.$transaction([
      prisma.passwordReset.update({
        where: { id: reset.id },
        data: { usedAt: new Date() },
      }),
      // Invalidate any other unused rows for the same email
      prisma.passwordReset.updateMany({
        where: {
          email: emailLower,
          usedAt: null,
          id: { not: reset.id },
        },
        data: { usedAt: new Date() },
      }),
      prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: newHash },
      }),
    ]);

    return NextResponse.json({
      success: true,
      message:
        "Your password has been reset successfully. You can now sign in with your new password.",
    });
  } catch (err) {
    console.error("[reset-password] Unexpected error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
