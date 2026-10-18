/**
 * POST /api/accounts/[id]/validate
 *
 * Does NOT call Graph API directly (§10). Instead enqueues a
 * lightweight "validate" job to the worker via BullMQ and waits
 * for the result.
 *
 * IMPORTANT (connection-leak fix):
 * Previously this route created a `new Queue(VALIDATE_QUEUE, ...)`
 * AND a `new QueueEvents(VALIDATE_QUEUE, ...)` per request — each
 * holding its own `redis.duplicate()` connection. They were only
 * closed on the happy path; the documented timeout branch (and any
 * other rejection) leaked both.
 *
 * Now:
 *   - The Queue is a process-wide singleton via `getValidateQueue(redis)`.
 *     It is NEVER closed by a request handler — it lives for the lifetime
 *     of the web process and is closed by `instrumentation.ts` on
 *     SIGTERM/SIGINT.
 *   - The QueueEvents is still per-request (it subscribes to completion
 *     events for one specific job), but it is now wrapped in `try/finally`
 *     so it is ALWAYS closed — success, timeout, or any thrown error.
 */

import { NextRequest, NextResponse } from "next/server";
import { QueueEvents } from "bullmq";
import { getSession, AuthError } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireAccount } from "@/lib/ownership";
import { getRedis } from "@/lib/redis";
import { getValidateQueue, VALIDATE_QUEUE } from "@/lib/queues/helpers";

interface ValidateJobData {
  accountId: string;
  encryptedToken: string;
  fbPageId: string;
  fbApiVersion: string;
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Pre-flight: auth + ownership + DB lookup run BEFORE we touch any
  // BullMQ resource, so auth/404 failures don't need cleanup.
  let userId: string;
  let id: string;
  try {
    const session = await getSession();
    userId = session.sub;
    id = (await params).id;
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  let accountOwned: unknown;
  try {
    accountOwned = await requireAccount(userId, id);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
  void accountOwned; // ownership verified; nothing else needed from it

  const accountWithToken = await prisma.account.findFirst({
    where: { id, userId },
    select: { fbPageAccessToken: true, fbPageId: true, fbApiVersion: true },
  });
  if (!accountWithToken) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // ── BullMQ section ────────────────────────────────────────────
  //
  // The Queue is a singleton (no per-request Redis connection for it).
  // The QueueEvents is genuinely per-request — it's a pub/sub subscriber
  // that listens for the completion event of THIS specific job. It MUST
  // be closed in `finally` so success / timeout / any rejection all
  // release its Redis connection.
  const redis = getRedis();
  const queue = getValidateQueue(redis);
  const queueEvents = new QueueEvents(VALIDATE_QUEUE, {
    connection: redis.duplicate(),
  });

  try {
    await queueEvents.waitUntilReady();

    const job = await queue.add(
      `validate:${id}`,
      {
        accountId: id,
        encryptedToken: accountWithToken.fbPageAccessToken,
        fbPageId: accountWithToken.fbPageId,
        fbApiVersion: accountWithToken.fbApiVersion,
      } as ValidateJobData,
      {
        // Validate jobs shouldn't retry — if it fails, it fails
        attempts: 1,
      }
    );

    // Wait for the worker to process and return the result (15s TTL)
    const result = await job.waitUntilFinished(queueEvents, 15_000);

    // Worker returns { success, page?, error? }
    const payload = result as {
      success: boolean;
      page?: { id: string; name: string };
      error?: string;
    };

    if (payload.success) {
      return NextResponse.json({ success: true, page: payload.page });
    }
    return NextResponse.json(
      { success: false, error: payload.error || "Validation failed" },
      { status: 400 }
    );
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof Error && err.message.includes("timeout")) {
      return NextResponse.json(
        { success: false, error: "Validation timed out" },
        { status: 408 }
      );
    }
    console.error("[accounts:validate]", err);
    return NextResponse.json(
      { success: false, error: "Could not validate this account right now." },
      { status: 400 }
    );
  } finally {
    // ALWAYS close the per-request QueueEvents — no matter whether the
    // job succeeded, timed out, threw, or was rejected by the worker.
    // This is the single point that guarantees no QueueEvents Redis
    // connection can leak from this route.
    try {
      await queueEvents.close();
    } catch {
      // Swallow — we're already in cleanup; nothing useful to do.
    }
    // NOTE: we intentionally do NOT close `queue` here — it's the
    // process-wide singleton and will be closed by `closeQueues()`
    // on shutdown.
  }
}
