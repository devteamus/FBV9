/**
 * Scheduled cleanup tasks.
 *
 * Replaces v1's per-tick cleanup checks.  Instead of running every 30s
 * in the posting loop, these are BullMQ repeatable jobs that run
 * independently — no coupling to the posting path.
 *
 * Two scheduled jobs:
 * 1. CSV file cleanup (after retention window)
 * 2. Old job/post purge (after retention window)
 */

import { Queue } from "bullmq";
import { getRedis } from "../lib/redis.js";
import { prisma } from "../lib/prisma.js";
import fs from "node:fs";
import path from "node:path";

const CLEANUP_QUEUE = "cleanup";

const CSV_RETENTION_HOURS = parseInt(
  process.env.CSV_RETENTION_HOURS || "24",
  10
);
const JOB_RETENTION_DAYS = parseInt(
  process.env.JOB_RETENTION_DAYS || "15",
  10
);

/**
 * Register scheduled cleanup jobs. Call once at worker boot.
 *
 * v2.3 — registration race fix: THREE worker containers boot
 * concurrently (worker, worker-2, worker-3) and each used to run
 * `getRepeatableJobs → removeRepeatableByKey → add` unsynchronized.
 * Two workers passing the empty-list check at the same instant both
 * re-added the same repeatable config → two parallel job chains
 * (double cleanup runs + orphaned delayed jobs that later fail with
 * "Couldn't find repeatable job"). A short Redis lock now serializes
 * the register section; siblings that lose the race VERIFY the jobs
 * exist (a stale lock resurrected from the AOF after a full-stack
 * restart must never leave the queue unregistered) and otherwise
 * wait the lock out and take over.
 */
export async function registerCleanupJobs(): Promise<void> {
  const redis = getRedis();
  const LOCK_KEY = "fbv9:cleanup-registration-lock";
  const LOCK_TTL_S = 15;

  const acquired = await redis.set(
    LOCK_KEY,
    String(process.pid),
    "EX",
    LOCK_TTL_S,
    "NX"
  );

  if (acquired !== "OK") {
    // A sibling worker holds the lock — either it is registering right
    // now, or it registered moments ago (lock lingers for its TTL).
    // Verify the repeatable jobs actually exist before trusting it.
    let alreadyRegistered = false;
    const probeQueue = new Queue(CLEANUP_QUEUE, {
      connection: redis.duplicate(),
    });
    try {
      const existing = await probeQueue.getRepeatableJobs();
      if (existing.length >= 2) {
        alreadyRegistered = true;
      }
    } finally {
      await probeQueue.close();
    }
    if (alreadyRegistered) {
      console.log(
        "[cleanup] Repeatable jobs already registered by a sibling worker — skipping"
      );
      return;
    }
    // Not actually registered (stale lock from a previous boot cycle)
    // → wait out the TTL and take over the registration ourselves.
    await new Promise((r) => setTimeout(r, (LOCK_TTL_S + 1) * 1000));
    const retried = await redis.set(
      LOCK_KEY,
      String(process.pid),
      "EX",
      LOCK_TTL_S,
      "NX"
    );
    if (retried !== "OK") {
      // Someone else genuinely took over in the meantime — trust them.
      console.log(
        "[cleanup] Sibling worker is registering cleanup jobs — skipping"
      );
      return;
    }
  }

  const queue = new Queue(CLEANUP_QUEUE, {
    connection: redis.duplicate(),
  });

  try {
    // Remove old repeatable jobs before re-registering
    // (prevents duplicates on worker restart)
    const existing = await queue.getRepeatableJobs();
    for (const job of existing) {
      await queue.removeRepeatableByKey(job.key);
    }

    // CSV cleanup: every 30 minutes
    await queue.add(
      "cleanup-csv",
      {},
      {
        repeat: { every: 30 * 60 * 1000 },
      }
    );

    // Old job purge: every 6 hours
    await queue.add(
      "cleanup-old-jobs",
      {},
      {
        repeat: { every: 6 * 60 * 60 * 1000 },
      }
    );
  } finally {
    await queue.close();
  }
  console.log(
    `[cleanup] Registered: CSV cleanup (every 30m), job purge (every 6h)`
  );
}

/**
 * Process a cleanup job. Called by the worker.
 */
export async function processCleanupJob(jobName: string): Promise<void> {
  if (jobName === "cleanup-csv") {
    await cleanupCsvFiles();
  } else if (jobName === "cleanup-old-jobs") {
    await cleanupOldJobs();
  }
}

/**
 * Delete CSV files for completed jobs older than retention window.
 * Matches v1's _cleanup_csv logic exactly.
 */
async function cleanupCsvFiles(): Promise<void> {
  const cutoff = new Date(
    Date.now() - CSV_RETENTION_HOURS * 60 * 60 * 1000
  );

  const jobs = await prisma.job.findMany({
    where: {
      status: "completed",
      csvDeleted: false,
      completedAt: { lte: cutoff },
    },
    select: { id: true, filename: true },
  });

  for (const job of jobs) {
    const filepath = path.join("/app/uploads", job.filename);
    if (fs.existsSync(filepath)) {
      try {
        fs.unlinkSync(filepath);
        console.log(`[cleanup] Deleted CSV for Job ${job.id}`);
      } catch (err) {
        console.warn(
          `[cleanup] Could not delete CSV for Job ${job.id}: ${err}`
        );
      }
    }
    await prisma.job.update({
      where: { id: job.id },
      data: {
        csvDeleted: true,
        csvDeletedAt: new Date(),
      },
    });
  }

  if (jobs.length > 0) {
    console.log(`[cleanup] Cleaned up ${jobs.length} CSV file(s)`);
  }
}

/**
 * Purge completed/failed jobs older than retention window.
 * Cascades to Post rows (Prisma onDelete: Cascade).
 * Matches v1's _cleanup_old_jobs logic exactly.
 */
async function cleanupOldJobs(): Promise<void> {
  const cutoff = new Date(
    Date.now() - JOB_RETENTION_DAYS * 24 * 60 * 60 * 1000
  );

  // First delete any remaining CSV files
  const jobs = await prisma.job.findMany({
    where: {
      status: { in: ["completed", "failed"] },
      completedAt: { lte: cutoff },
    },
    select: { id: true, filename: true },
  });

  let purgedCount = 0;

  for (const job of jobs) {
    // Delete CSV if it still exists
    const filepath = path.join("/app/uploads", job.filename);
    if (fs.existsSync(filepath)) {
      try {
        fs.unlinkSync(filepath);
      } catch {
        // best effort
      }
    }

    // Count posts before deleting (for logging)
    const postCount = await prisma.post.count({
      where: { jobId: job.id },
    });

    // Delete job (cascades to posts)
    await prisma.job.delete({ where: { id: job.id } });

    purgedCount++;
    console.log(
      `[cleanup] Purged Job ${job.id} and ${postCount} post record(s)`
    );
  }

  if (purgedCount > 0) {
    console.log(
      `[cleanup] Purged ${purgedCount} old job(s) (> ${JOB_RETENTION_DAYS} days)`
    );
  }
}
