/**
 * GET /api/health — reports web + worker + Redis + Postgres status (§8)
 *
 * No auth required — used by monitoring / Docker healthcheck.
 *
 * IMPORTANT (connection-leak fix):
 * This endpoint is hit by Docker healthcheck every 10s (with up to 5
 * retries). It MUST NOT create any new Redis connection or BullMQ Queue
 * per request — that was the original leak (~6 leaked connections per
 * minute, 24/7, even with zero user activity).
 *
 * All Redis / BullMQ access here goes through singleton handles that
 * live for the lifetime of the web process:
 *   - `getRedis()`              → 1 base ioredis connection (singleton)
 *   - `getCleanupQueue(redis)`  → 1 BullMQ Queue (cached, holds 1
 *                                 `redis.duplicate()` connection)
 *
 * The response also exposes Redis `connected_clients` / `blocked_clients`
 * / `rejected_connections` so a future leak can be detected by monitoring
 * these counters (they must stay bounded over time).
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { getCleanupQueue } from "@/lib/queues/helpers";

export async function GET() {
  const checks: Record<string, string> = {};

  // Postgres check
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.postgres = "ok";
  } catch {
    checks.postgres = "error";
  }

  // Redis check — uses the singleton connection, no new connection.
  // Also collects connected_clients / blocked_clients / rejected_connections
  // via INFO so a future connection leak is visible from the outside.
  let redisClients: { connected?: number; blocked?: number; rejected?: number } = {};
  try {
    const redis = getRedis();
    await redis.ping();
    checks.redis = "ok";

    // `redis.info()` is a single round-trip on the SAME singleton
    // connection. Parse the leak-detection counters out of the text.
    try {
      const info = await redis.info();
      redisClients = parseRedisClientMetrics(info);
    } catch {
      // INFO failing is non-fatal — health check still reports ok.
    }
  } catch {
    checks.redis = "error";
  }

  // Worker check: see if any worker is consuming
  // (check if cleanup queue has been registered = worker is alive)
  //
  // Uses the singleton `getCleanupQueue(redis)` — BullMQ's
  // `getRepeatableJobs()` runs over the cached Queue's existing
  // duplicated connection. No new connection is opened per request.
  try {
    const redis = getRedis();
    const cleanupQueue = getCleanupQueue(redis);
    const repeatableJobs = await cleanupQueue.getRepeatableJobs();
    checks.worker = repeatableJobs.length > 0 ? "running" : "no worker";
  } catch {
    checks.worker = "unknown";
  }

  const allOk =
    checks.postgres === "ok" &&
    checks.redis === "ok" &&
    checks.worker === "running";

  return NextResponse.json(
    {
      status: allOk ? "ok" : "degraded",
      ...checks,
      // Monitoring-only fields (additive; do not affect `allOk`).
      // Watch these over time — if `connected` grows monotonically,
      // there is a connection leak somewhere in the app.
      redis_clients: redisClients,
    },
    { status: allOk ? 200 : 503 }
  );
}

/**
 * Parse the leak-detection counters out of Redis `INFO` output.
 * Returns only what we care about; missing fields stay `undefined`.
 */
function parseRedisClientMetrics(info: string): {
  connected?: number;
  blocked?: number;
  rejected?: number;
} {
  const out: { connected?: number; blocked?: number; rejected?: number } = {};
  for (const line of info.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx);
    const value = trimmed.slice(idx + 1);
    if (key === "connected_clients") {
      out.connected = Number(value);
    } else if (key === "blocked_clients") {
      out.blocked = Number(value);
    } else if (key === "rejected_connections") {
      out.rejected = Number(value);
    }
  }
  return out;
}
