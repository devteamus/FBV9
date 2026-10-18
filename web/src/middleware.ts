/**
 * Next.js middleware — runs on every request.
 * Security headers (§7B) and CORS (§7).
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const ALLOWED_METHODS = ["GET", "POST", "PUT", "DELETE", "OPTIONS"];

export function middleware(request: NextRequest) {
  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return addSecurityHeaders(
      new NextResponse(null, { status: 204 }),
      request
    );
  }

  // Block non-allowed methods early
  if (!ALLOWED_METHODS.includes(request.method)) {
    return addSecurityHeaders(
      NextResponse.json({ error: "Method not allowed" }, { status: 405 }),
      request
    );
  }

  const response = NextResponse.next();
  return addSecurityHeaders(response, request);
}

function addSecurityHeaders(response: NextResponse, request: NextRequest) {
  // CORS: exact origin allowlist (§7B)
  const corsOrigins = (process.env.CORS_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const origin = request.headers.get("origin");

  if (corsOrigins.length > 0 && !corsOrigins.includes("*") && origin) {
    if (corsOrigins.includes(origin)) {
      response.headers.set("Access-Control-Allow-Origin", origin);
      response.headers.set("Access-Control-Allow-Credentials", "true");
      response.headers.set(
        "Access-Control-Allow-Methods",
        "GET,POST,PUT,DELETE,OPTIONS"
      );
      response.headers.set(
        "Access-Control-Allow-Headers",
        "Content-Type,Authorization"
      );
      response.headers.set("Access-Control-Max-Age", "86400");
    }
    // If origin not in allowlist, we simply don't set CORS headers
    // — the browser will block the response
  }

  // Security headers (§7B)
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "Permissions-Policy",
    "geolocation=(), microphone=(), camera=()"
  );
  response.headers.set(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains"
  );

  return response;
}

// Match API routes, root, and the public pages so they all get security headers.
// Dashboard routes are protected by the api.me() call in the dashboard layout,
// not by middleware, so they don't need to be matched here.
export const config = {
  matcher: [
    "/api/:path*",
    "/",
    "/privacy-policy",
    "/terms",
    "/forgot-password",
  ],
};
