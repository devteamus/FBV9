/**
 * POST /api/upload — CSV upload → bulk job creation + BullMQ enqueue
 *
 * v2.2 changes:
 * - OPTIONAL `start_at` field: user-selected start time in Bangladesh time
 *   (BDT = UTC+6, no DST). The FIRST post fires exactly at that moment,
 *   each next post one interval later. Empty/absent → legacy behavior
 *   (first post fires immediately on upload).
 * - Posts are created DIRECTLY as "scheduled" with generated ids and
 *   precomputed scheduledAt (single createMany) instead of the old
 *   pending→findMany→N×update flow. A 5000-row CSV no longer issues
 *   5000 parallel updates + a re-query inside the request.
 * - Enqueue failure after the DB write rolls the whole job back
 *   (cancel partial queue entries + delete job) — no stuck "scheduled"
 *   posts without queue jobs.
 *
 * Port of v1's upload endpoint with all validation:
 * - CSV extension + content sniff (reject binaries)
 * - Required 'caption' column
 * - Row validation (URLs for non-text, length limits)
 * - Env-configurable MAX_CSV_ROWS
 * - File stored under /app/uploads/{userId}/{jobId}/ for isolation (§7A)
 *
 * Does NOT call Graph API (§10). Just creates DB records + enqueues.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, AuthError, ValidationError } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireAccount } from "@/lib/ownership";
import { enqueueJobPosts, cancelJobPostsByIds } from "@/lib/queues/helpers";
import { getRedis } from "@/lib/redis";
import { parse } from "csv-parse/sync";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const VALID_TYPES = new Set(["text", "image", "video", "reel"]);
const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
const ALL_CONTROL_RE = /[\x00-\x1f]/g;

// Rate limit: 20 uploads per hour per IP
//
// v2.3 — memory-leak fix: entries used to be added per unique IP and
// NEVER removed (only reset when the same IP returned after its
// window). Bots / rotating IPs could grow the Map without bound over
// weeks of uptime. Now: expired entries are swept whenever the Map
// grows past UPLOAD_MAP_CEILING, and the ceiling itself is a hard cap
// (further IPs are rate-limited until the next sweep frees space).
const uploadAttempts = new Map<string, { count: number; resetAt: number }>();
const UPLOAD_LIMIT = 20;
const UPLOAD_WINDOW_MS = 60 * 60 * 1000;
const UPLOAD_MAP_CEILING = 10_000;

function sweepExpiredUploadAttempts(now: number): void {
  for (const [ip, entry] of uploadAttempts) {
    if (now > entry.resetAt) uploadAttempts.delete(ip);
  }
}

function checkUploadRateLimit(ip: string): boolean {
  const now = Date.now();
  // Sweep at >= (not >) the ceiling: at exactly ceiling size the map
  // is full — if most entries are expired they MUST be reclaimed
  // before refusing anyone, otherwise new IPs are blocked by dead
  // entries forever.
  if (uploadAttempts.size >= UPLOAD_MAP_CEILING) {
    sweepExpiredUploadAttempts(now);
  }
  const entry = uploadAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    if (uploadAttempts.size >= UPLOAD_MAP_CEILING) {
      // Ceiling still reached after the sweep — refuse rather than grow
      // without bound (spoofed x-forwarded-for IPs would otherwise
      // bypass the per-IP limit AND exhaust memory).
      return false;
    }
    uploadAttempts.set(ip, { count: 1, resetAt: now + UPLOAD_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= UPLOAD_LIMIT;
}

// Client/server clock-skew tolerance for `start_at` (2 minutes). Anything
// older than this is treated as a genuine mistake and rejected; anything
// inside the window is silently clamped up to "now".
const START_TIME_SKEW_MS = 2 * 60 * 1000;

/**
 * Parse the optional `start_at` form field into a Date.
 *
 * Accepted inputs:
 *  - full ISO string with offset, e.g. "2026-10-20T11:00:00+06:00"
 *    (the dashboard converts its datetime-local picker to this form and
 *    pins it to Bangladesh time, GMT+6, regardless of browser locale)
 *  - bare datetime-local value "YYYY-MM-DDTHH:mm" → interpreted as BDT
 *
 * Returns null when the field is absent/empty (legacy immediate start).
 */
function parseStartTime(raw: string | null): Date | null {
  const value = (raw || "").trim();
  if (!value) return null;

  let iso = value;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(iso)) {
    iso = `${iso}:00+06:00`; // bare datetime-local → Bangladesh time
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError(
      "Start time is not a valid date/time. Use the date-time picker (Bangladesh time, GMT+6)."
    );
  }
  if (parsed.getTime() < Date.now() - START_TIME_SKEW_MS) {
    throw new ValidationError(
      "Start time must be in the future (Bangladesh time, GMT+6). Leave it empty to start posting immediately."
    );
  }
  // Clamp tiny skew (or "now") up to the current moment so the first post
  // never lands in the past.
  return new Date(Math.max(parsed.getTime(), Date.now()));
}

export async function POST(request: NextRequest) {
  let filePath: string | null = null;
  let createdJobId: string | null = null;
  let enqueued = false;
  let enqueuePayload: Array<{
    id: string;
    postType: string;
    scheduledAt: Date;
  }> = [];

  try {
    const { sub: userId } = await getSession();

    // Rate limit
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    if (!checkUploadRateLimit(ip)) {
      return NextResponse.json(
        { error: "Too many uploads. Try again later." },
        { status: 429 }
      );
    }

    const formData = await request.formData();
    const file = formData.get("csv") as File | null;
    const accountId = formData.get("account_id") as string | null;
    const intervalValue = parseInt(formData.get("interval_value") as string || "1", 10);
    const intervalUnit = (formData.get("interval_unit") as string) || "hours";

    if (!file) throw new ValidationError("No file part");
    if (!accountId) throw new ValidationError("account_id is required");

    // v2.3 — OOM guard: hard byte cap checked BEFORE the body is
    // buffered into RAM. MAX_CSV_ROWS alone cannot prevent a single
    // oversized request from consuming the web container's memory
    // budget (Next.js route handlers have no built-in body-size limit,
    // and formData() buffers the entire part before this code runs).
    // file.size comes from the multipart headers — free to read.
    const MAX_CSV_BYTES = parseInt(
      process.env.MAX_CSV_BYTES || String(10 * 1024 * 1024),
      10
    );
    if (file.size > MAX_CSV_BYTES) {
      throw new ValidationError(
        `CSV file is too large (${(file.size / 1024 / 1024).toFixed(1)} MB) — max allowed is ${(MAX_CSV_BYTES / 1024 / 1024).toFixed(0)} MB`
      );
    }

    // Ownership check on account
    const account = await requireAccount(userId, accountId);
    if (!account.isActive) {
      throw new ValidationError("Account is not active");
    }

    // Validate interval
    if (isNaN(intervalValue) || intervalValue < 1) {
      throw new ValidationError("Interval must be at least 1");
    }
    let intervalMinutes: number;
    if (intervalUnit === "minutes") intervalMinutes = intervalValue;
    else if (intervalUnit === "hours") intervalMinutes = intervalValue * 60;
    else if (intervalUnit === "days") intervalMinutes = intervalValue * 60 * 24;
    else intervalMinutes = 60;

    // Optional user-selected start time (Bangladesh time, GMT+6).
    // null → legacy behavior: the first post fires immediately.
    const userStartAt = parseStartTime(formData.get("start_at") as string | null);
    const startAt = userStartAt ?? new Date();

    // Validate file extension
    const originalName = file.name;
    if (!originalName.toLowerCase().endsWith(".csv")) {
      throw new ValidationError("Only .csv files allowed");
    }

    // Read file content
    const rawBytes = await file.arrayBuffer();
    const buffer = Buffer.from(rawBytes);

    // Content sniff: reject binaries (same as v1)
    if (buffer.includes(0x00)) {
      throw new ValidationError("File does not look like a valid CSV");
    }
    try {
      buffer.toString("utf-8");
    } catch {
      try {
        buffer.toString("latin1");
      } catch {
        throw new ValidationError("File does not look like a valid CSV");
      }
    }

    // Parse CSV
    const records = parse(buffer.toString("utf-8"), {
      columns: true,
      skip_empty_lines: true,
      bom: true,
    }) as Record<string, string>[];

    const MAX_CSV_ROWS = parseInt(process.env.MAX_CSV_ROWS || "5000", 10);
    if (records.length === 0) throw new ValidationError("CSV has no rows");
    if (records.length > MAX_CSV_ROWS) {
      throw new ValidationError(
        `CSV has ${records.length} rows — max allowed is ${MAX_CSV_ROWS}`
      );
    }

    // Validate all rows before importing anything
    const badRows: number[] = [];
    for (let idx = 0; idx < records.length; idx++) {
      const row = records[idx];
      const ptype = (row.post_type || "image").toLowerCase().trim() || "image";
      const type = VALID_TYPES.has(ptype) ? ptype : "image";
      const url = (row.media_url || "").trim();
      const caption = row.caption || "";
      const comment = row.comment || "";
      // Extra delayed comments — both fully optional. Any left blank in
      // the CSV are simply never created, so a user who wants zero, one,
      // or two extra comments just fills in what they want.
      const comment1Delay = (row.comment_1_delay_minutes || "").trim();
      const comment2 = (row.comment_2 || "").trim();
      const comment3 = (row.comment_3 || "").trim();
      const comment2Delay = (row.comment_2_delay_minutes || "").trim();
      const comment3Delay = (row.comment_3_delay_minutes || "").trim();

      if (type !== "text") {
        try {
          const parsed = new URL(url);
          if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
            badRows.push(idx + 2);
          }
        } catch {
          badRows.push(idx + 2);
        }
      }
      if (url.length > 2000 || caption.length > 5000 || comment.length > 2000) {
        badRows.push(idx + 2);
      }
      if (comment2.length > 2000 || comment3.length > 2000) {
        badRows.push(idx + 2);
      }
      // comment_1_delay_minutes is optional: blank or 0 = post the comment
      // right after the post goes live (old behaviour). A positive number
      // delays it by that many minutes.
      if (comment1Delay && (isNaN(Number(comment1Delay)) || Number(comment1Delay) < 0)) {
        badRows.push(idx + 2);
      }
      // If a comment text is given, its delay must be a valid positive number
      // (and vice versa — a delay with no message makes no sense).
      if (comment2 && (!comment2Delay || isNaN(Number(comment2Delay)) || Number(comment2Delay) < 1)) {
        badRows.push(idx + 2);
      }
      if (comment3 && (!comment3Delay || isNaN(Number(comment3Delay)) || Number(comment3Delay) < 1)) {
        badRows.push(idx + 2);
      }
      if (badRows.length >= 10) break;
    }
    if (badRows.length > 0) {
      const preview = badRows.slice(0, 10).join(", ");
      throw new ValidationError(
        `Invalid row(s): ${preview}${badRows.length >= 10 ? " ..." : ""}. media_url is required (full http(s) link) for image/video/reel rows, caption max 5000 chars, comment max 2000 chars.`
      );
    }

    // Save CSV file (isolated path: /app/uploads/{userId}/{jobId}/...)
    // Server-generated path only, never client-supplied (§7A)
    const jobId = crypto.randomUUID(); // pre-generate for filename
    const uploadDir = path.join("/app/uploads", userId, jobId);
    await mkdir(uploadDir, { recursive: true });
    const filename = `${jobId}.csv`;
    filePath = path.join(uploadDir, filename);
    await writeFile(filePath, buffer);

    // ── Build every Post row up-front (v2.2) ────────────────────
    // ids are generated HERE (crypto.randomUUID) so the BullMQ jobIds are
    // known without a re-query, and each row already carries its final
    // "scheduled" status + scheduledAt. One createMany = one DB write.
    const postRows = records.map((row, index) => {
      const ptype = (row.post_type || "image").toLowerCase().trim() || "image";
      const type = VALID_TYPES.has(ptype) ? ptype : "image";
      const caption = (row.caption || "").replace(CONTROL_CHARS_RE, "");
      const mediaUrl = (row.media_url || "").replace(ALL_CONTROL_RE, "");
      const rawComment = (row.comment || "").trim();
      const comment1DelayNum = Math.round(Number((row.comment_1_delay_minutes || "").trim() || "0"));
      // Delay > 0 → handled as a delayed ScheduledComment below, so it must
      // NOT also be stored as the immediate Post.comment.
      const comment =
        rawComment && comment1DelayNum <= 0
          ? rawComment.replace(CONTROL_CHARS_RE, "")
          : null;

      const id = crypto.randomUUID();
      const scheduledAt = new Date(
        startAt.getTime() + index * intervalMinutes * 60_000
      );
      return {
        id,
        jobId,
        userId,
        accountId,
        caption,
        mediaUrl,
        postType: type,
        comment,
        csvRowIndex: index, // preserve CSV order — used for dashboard sorting
        status: "scheduled" as const,
        scheduledAt,
        bullJobId: id, // postId doubles as the BullMQ jobId (idempotency)
      };
    });

    // Create Job + Posts in a transaction
    const createdJob = await prisma.$transaction(async (tx) => {
      const job = await tx.job.create({
        data: {
          userId,
          accountId,
          filename: path.join(userId, jobId, filename), // relative path for DB
          originalFilename: originalName,
          status: "pending",
          intervalMinutes,
          scheduledStartAt: userStartAt, // null = started immediately (legacy)
          totalPosts: records.length,
        },
      });

      if (postRows.length > 0) {
        await tx.post.createMany({ data: postRows });
      }

      return job;
    });
    createdJobId = createdJob.id;

    // Enqueue all posts into BullMQ (batched addBulk, v2.2)
    const redis = getRedis();
    const postsToEnqueue = postRows.map((p, index) => ({
      id: p.id,
      jobId: createdJob.id,
      accountId,
      pageId: account.fbPageId,
      postType: p.postType,
      index,
      intervalMinutes,
      startAt,
    }));
    // Snapshot for the rollback path (cancel partial entries by direct id)
    enqueuePayload = postRows.map((p) => ({
      id: p.id,
      postType: p.postType,
      scheduledAt: p.scheduledAt,
    }));

    try {
      await enqueueJobPosts(redis, postsToEnqueue);
      enqueued = true;
    } catch (enqueueErr) {
      // Roll the whole job back — no half-scheduled uploads. Posts in the
      // DB are already "scheduled", so without this the job would look
      // alive while nothing is in the queue (stuck forever).
      console.error("[upload] enqueue failed — rolling back job", enqueueErr);
      try {
        await cancelJobPostsByIds(redis, enqueuePayload);
      } catch {
        // best effort — the job delete below still removes DB state
      }
      await prisma.job.delete({ where: { id: createdJob.id } }); // cascades posts
      createdJobId = null;
      throw enqueueErr;
    }

    // Create any optional extra delayed comments (comment_2/comment_3 and
    // delayed comment_1). Rows that left these blank contribute nothing —
    // that's the auto-skip behavior. postRows is in the same order as
    // `records`, so index-mapping stays correct without a re-query.
    const scheduledCommentRows: {
      postId: string;
      message: string;
      delayMinutes: number;
    }[] = [];
    records.forEach((row, index) => {
      const post = postRows[index];
      if (!post) return;
      const comment1 = (row.comment || "").trim();
      const comment1DelayNum = Math.round(Number((row.comment_1_delay_minutes || "").trim() || "0"));
      if (comment1 && comment1DelayNum > 0) {
        scheduledCommentRows.push({
          postId: post.id,
          message: comment1.replace(CONTROL_CHARS_RE, ""),
          delayMinutes: comment1DelayNum,
        });
      }
      const comment2 = (row.comment_2 || "").trim();
      const comment3 = (row.comment_3 || "").trim();
      if (comment2) {
        scheduledCommentRows.push({
          postId: post.id,
          message: comment2.replace(CONTROL_CHARS_RE, ""),
          delayMinutes: Math.round(Number(row.comment_2_delay_minutes)),
        });
      }
      if (comment3) {
        scheduledCommentRows.push({
          postId: post.id,
          message: comment3.replace(CONTROL_CHARS_RE, ""),
          delayMinutes: Math.round(Number(row.comment_3_delay_minutes)),
        });
      }
    });
    if (scheduledCommentRows.length > 0) {
      await prisma.scheduledComment.createMany({ data: scheduledCommentRows });
    }

    // Mark job as running (it is live from the API's perspective — the
    // individual posts carry their own future scheduledAt times)
    await prisma.job.update({
      where: { id: createdJob.id },
      data: { status: "running", startedAt: new Date() },
    });

    const finalJob = await prisma.job.findUniqueOrThrow({
      where: { id: createdJob.id },
      include: { account: { select: { id: true, name: true } } },
    });

    return NextResponse.json(
      { success: true, job: serializeJob(finalJob) },
      { status: 201 }
    );
  } catch (err) {
    // Clean up uploaded file on error
    if (filePath) {
      try {
        const { unlink } = await import("node:fs/promises");
        await unlink(filePath);
      } catch {
        // best effort
      }
    }
    // Safety net: if the job row was created but the enqueue step never
    // completed (e.g. Redis unreachable between the DB write and the
    // enqueue), remove it. Once `enqueued` is true the job is LIVE in the
    // queue — a later, unrelated error (comment rows, status update) must
    // NOT delete a working job out from under the user.
    if (createdJobId && !enqueued) {
      try {
        await prisma.job.delete({ where: { id: createdJobId } });
      } catch {
        // already deleted or never committed — fine
      }
    }

    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[upload]", err);
    return NextResponse.json(
      { error: "Could not process this CSV. Please check the format and try again." },
      { status: 500 }
    );
  }
}

// Import serializeJob for the response
import { serializeJob } from "@/lib/ownership";
