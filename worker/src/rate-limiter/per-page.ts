/**
 * Per-page rate limiter using Redis token bucket.
 *
 * Facebook rate-limits per Page access token, not globally.
 * Each page gets its own rate budget — a user with 25 pages gets
 * 25 independent lanes (§3).  One page's burst never delays
 * another page's posts.
 *
 * On rate-limit error, requeue is scoped to that page only.
 */

import type { Redis } from "ioredis";

const DEFAULT_RATE_LIMIT = 25; // calls per window
const DEFAULT_WINDOW_MS = 60_000; // 1 minute window

function bucketKey(pageId: string): string {
  return `ratelimit:page:${pageId}`;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

/**
 * Check if a request for the given page is allowed under rate limit.
 * Uses a sliding-window counter in Redis.
 *
 * Returns { allowed, remaining, resetMs }.
 */
export async function checkRateLimit(
  redis: Redis,
  pageId: string,
  options?: {
    limit?: number;
    windowMs?: number;
  }
): Promise<RateLimitResult> {
  const limit = options?.limit ?? DEFAULT_RATE_LIMIT;
  const windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS;
  const key = bucketKey(pageId);
  const now = Date.now();
  const windowStart = now - windowMs;

  // Pipeline: remove expired entries + count current + add new entry
  const pipeline = redis.pipeline();
  pipeline.zremrangebyscore(key, "-inf", String(windowStart));
  pipeline.zadd(key, now, `${now}:${Math.random()}`);
  pipeline.zcard(key);
  pipeline.pexpire(key, windowMs + 1000);
  const results = await pipeline.exec();

  // results[2] is the zcard result
  const currentCount = (results?.[2]?.[1] as number) ?? 0;
  const allowed = currentCount <= limit;
  const remaining = Math.max(0, limit - currentCount);

  return {
    allowed,
    remaining,
    resetMs: windowMs,
  };
}

/**
 * Get a backoff delay in ms when a page is rate-limited.
 * Uses exponential backoff based on how many times this page has
 * been rate-limited recently.
 */
export function getRateLimitBackoff(attempt: number): number {
  // Base 5 seconds, exponential: 5s, 10s, 20s, 40s… capped at 5 min
  const base = 5_000;
  const delay = base * Math.pow(2, attempt - 1);
  return Math.min(delay, 300_000);
}
