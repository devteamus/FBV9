/**
 * POST /api/auth/logout
 * Clears the session cookie (httpOnly) and returns success.
 */

import { NextResponse } from "next/server";
import { clearSessionCookie } from "@/lib/auth";

export async function POST() {
  return new NextResponse(
    JSON.stringify({ success: true }),
    {
      status: 200,
      headers: { "Set-Cookie": clearSessionCookie() },
    }
  );
}
