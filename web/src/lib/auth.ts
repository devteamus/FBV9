/**
 * JWT authentication helpers.
 * 
 * Session stored in httpOnly, Secure, SameSite=strict cookie (§7B).
 * Never in localStorage — localStorage is readable by any XSS'd JS.
 * Uses `jose` for pure-JS JWT (no native bindings needed in Alpine Docker).
 */

import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";

const COOKIE_NAME = "fbp_session";

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET environment variable is not set");
  }
  return new TextEncoder().encode(secret);
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function createToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(getSecret());
}

export interface SessionPayload {
  sub: string; // userId
}

/**
 * Extract and verify the current user's session from the httpOnly cookie.
 * Returns the userId. Throws if not authenticated.
 * 
 * This is the SOLE source of userId for all API routes.
 * Never trust a userId from request body/query (§7B).
 */
export async function getSession(): Promise<SessionPayload> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) {
    throw new AuthError("Not authenticated", 401);
  }
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return payload as unknown as SessionPayload;
  } catch {
    throw new AuthError("Invalid or expired session", 401);
  }
}

/**
 * Set the session cookie on a Response.
 */
export function setSessionCookie(token: string): string {
  const isDev = process.env.NODE_ENV === "development";
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; ${
    isDev ? "" : "Secure; "
  }SameSite=Strict; Max-Age=86400`;
}

/**
 * Clear the session cookie (logout).
 */
export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`;
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status: number = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

export class NotFoundError extends Error {
  status = 404;
  constructor(message = "Not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ForbiddenError extends Error {
  status = 403;
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class ValidationError extends Error {
  status = 400;
  details?: unknown;
  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "ValidationError";
    this.details = details;
  }
}
