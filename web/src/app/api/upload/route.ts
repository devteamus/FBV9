/**
 * POST /api/upload — CSV / XLSX upload → bulk job creation + BullMQ enqueue
 *
 * v2.4 changes:
 * - Accepts .csv AND .xlsx (Google Sheets / Excel downloads). Parsing lives
 *   in lib/post-sheet.ts: tolerant headers, auto delimiter (, ; tab),
 *   UTF-8 / UTF-16, ragged rows, blank "Excel" rows ignored.
 * - Comment 3 removed. Columns: comment_1 (+ comment_1_delay_minutes) and
 *   comment_2 (+ comment_2_delay_minutes). Old files with comment_3 columns
 *   still upload — those columns are ignored and a warning is returned.
 * - FIX "Could not process this CSV": parse errors used to escape as a
 *   generic 500. They are now reported as precise 400s (row number +
 *   reason), and every remaining failure names its stage.
 * - FIX: delayed-comment rows are now created INSIDE the job transaction,
 *   BEFORE anything is enqueued (previously created after enqueue, so a
 *   post firing immediately could publish before its comments existed).
 * - FIX: interactive-transaction timeout raised (default 5 s is too short
 *   for a 5000-row file → "Transaction already closed").
 * - FIX: failing to keep a copy of the upload on disk (volume permissions)
 *   no longer kills the upload — the copy is only used for retention.
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
import { parsePostSheet } from "@/lib/post-sheet";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const VALID_TYPES = new Set(["text", "image", "video", "reel"]);
const MAX_DELAY_MINUTES = 43_200; // 30 days — also keeps the value inside Postgres INT
const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
const ALL_CONTROL_RE = /[\x00-\x1f]/g;

// Rate limit: UPLOAD_LIMIT_PER_HOUR (default 300) uploads per hour per IP
//
// v2.3 — memory-leak fix: entries used to be added per unique IP and
// NEVER removed (only reset when the same IP returned after its
// window). Bots / rotating IPs could grow the Map without bound over
// weeks of uptime. Now: expired entries are swept whenever the Map
// grows past UPLOAD_MAP_CEILING, and the ceiling itself is a hard cap
// (further IPs are rate-limited until the next sweep frees space).
const uploadAttempts = new Map<string, { count: number; resetAt: number }>();
// 300/hour default: one CSV per page × 200 pages must not hit the limit.
const UPLOAD_LIMIT = parseInt(process.env.UPLOAD_LIMIT_PER_HOUR || "300", 10);
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

// ── In-flight memory gate ────────────────────────────────────────
// Parsing a 25 MB file needs ~10× its size in RAM. Without a gate, a few
// simultaneous big uploads would OOM-kill the web container (everyone's
// session dies). Uploads wait their turn instead: at most
// UPLOAD_INFLIGHT_BYTES (default 30 MB of files) are processed at once —
// i.e. one 25 MB file, or many small ones.
const INFLIGHT_LIMIT = parseInt(process.env.UPLOAD_INFLIGHT_BYTES || String(30 * 1024 * 1024), 10);
let inflightBytes = 0;
const waiters: Array<() => void> = [];

async function acquireUploadSlot(bytes: number): Promise<() => void> {
  const need = Math.min(bytes, INFLIGHT_LIMIT); // a single file is always admitted eventually
  const deadline = Date.now() + 120_000;
  while (inflightBytes > 0 && inflightBytes + need > INFLIGHT_LIMIT) {
    if (Date.now() > deadline) {
      throw new ValidationError("The server is busy processing other uploads. Please try again in a minute.");
    }
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
      setTimeout(resolve, 2_000); // re-check periodically
    });
  }
  inflightBytes += need;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inflightBytes -= need;
    waiters.splice(0).forEach((w) => w());
  };
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

type Stage = "auth" | "read" | "parse" | "save" | "db" | "queue";

/** Parse a delay cell. Returns null when blank, NaN when invalid. */
function parseDelay(raw: string): number | null {
  const v = raw.trim();
  if (!v) return null;
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) ? Math.round(n) : NaN;
}

export async function POST(request: NextRequest) {
  let filePath: string | null = null;
  let createdJobId: string | null = null;
  let enqueued = false;
  let stage: Stage = "auth";
  let releaseSlot: (() => void) | null = null;
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

    stage = "read";
    const formData = await request.formData();
    const file = (formData.get("csv") ?? formData.get("file")) as File | null;
    const accountId = formData.get("account_id") as string | null;
    const intervalValue = parseInt((formData.get("interval_value") as string) || "1", 10);
    const intervalUnit = (formData.get("interval_unit") as string) || "hours";

    if (!file || typeof file === "string") throw new ValidationError("No file part");
    if (!accountId) throw new ValidationError("account_id is required");

    // OOM guard: hard byte cap checked BEFORE the body is buffered.
    // .xlsx is a zip (decompresses in RAM) so it gets a tighter cap.
    const isXlsx = file.name.toLowerCase().endsWith(".xlsx");
    const MAX_CSV_BYTES = parseInt(process.env.MAX_CSV_BYTES || String(25 * 1024 * 1024), 10);
    const MAX_XLSX_BYTES = parseInt(process.env.MAX_XLSX_BYTES || String(25 * 1024 * 1024), 10);
    const maxBytes = isXlsx ? Math.min(MAX_XLSX_BYTES, MAX_CSV_BYTES) : MAX_CSV_BYTES;
    if (file.size > maxBytes) {
      throw new ValidationError(
        `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB) — max allowed is ${(maxBytes / 1024 / 1024).toFixed(0)} MB`
      );
    }

    // Wait for memory budget BEFORE buffering/parsing the file
    releaseSlot = await acquireUploadSlot(file.size);

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
    const userStartAt = parseStartTime(formData.get("start_at") as string | null);
    const startAt = userStartAt ?? new Date();

    const originalName = file.name;
    const buffer = Buffer.from(await file.arrayBuffer());

    // ── Parse (CSV or XLSX) ─────────────────────────────────────
    stage = "parse";
    const sheet = await parsePostSheet(buffer, originalName);
    const records = sheet.rows;

    const MAX_CSV_ROWS = parseInt(process.env.MAX_CSV_ROWS || "10000", 10);
    if (records.length === 0) throw new ValidationError("The file has no data rows.");
    if (records.length > MAX_CSV_ROWS) {
      throw new ValidationError(
        `The file has more than ${MAX_CSV_ROWS} data rows — max allowed is ${MAX_CSV_ROWS}. Split it into two files.`
      );
    }

    // ── Validate every row, report exact row + reason ───────────
    const problems: string[] = [];
    const addProblem = (rowNumber: number, msg: string) => {
      if (problems.length < 10) problems.push(`Row ${rowNumber}: ${msg}`);
    };

    for (const row of records) {
      const ptype = row.post_type.toLowerCase().trim();
      if (ptype && !VALID_TYPES.has(ptype)) {
        addProblem(row.rowNumber, `post_type "${row.post_type.trim()}" must be text, image, video or reel`);
        continue;
      }
      const type = ptype || "image";
      const url = row.media_url.trim();

      if (type === "text") {
        if (!row.caption.trim()) addProblem(row.rowNumber, "caption is required for text posts");
      } else {
        let ok = false;
        try {
          const u = new URL(url);
          ok = ["http:", "https:"].includes(u.protocol) && !!u.hostname;
        } catch {
          ok = false;
        }
        if (!ok) addProblem(row.rowNumber, `media_url must be a full http(s) link for ${type} posts`);
      }
      if (url.length > 2000) addProblem(row.rowNumber, "media_url is longer than 2000 characters");
      if (row.caption.length > 5000) addProblem(row.rowNumber, "caption is longer than 5000 characters");
      if (row.comment_1.length > 2000) addProblem(row.rowNumber, "comment_1 is longer than 2000 characters");
      if (row.comment_2.length > 2000) addProblem(row.rowNumber, "comment_2 is longer than 2000 characters");

      // comment_1_delay_minutes: optional. blank/0 = right after the post.
      const d1 = parseDelay(row.comment_1_delay_minutes);
      if (d1 !== null && (Number.isNaN(d1) || d1 < 0 || d1 > MAX_DELAY_MINUTES)) {
        addProblem(row.rowNumber, `comment_1_delay_minutes must be a number of minutes between 0 and ${MAX_DELAY_MINUTES}`);
      }
      // comment_2 needs its own delay (1+ minutes).
      if (row.comment_2.trim()) {
        const d2 = parseDelay(row.comment_2_delay_minutes);
        if (d2 === null || Number.isNaN(d2) || d2 < 1 || d2 > MAX_DELAY_MINUTES) {
          addProblem(row.rowNumber, `comment_2 needs comment_2_delay_minutes (a number of minutes, 1 or more)`);
        }
      }
      if (problems.length >= 10) break;
    }
    if (problems.length > 0) {
      throw new ValidationError(
        `Please fix these rows and upload again:\n${problems.join("\n")}${problems.length >= 10 ? "\n…" : ""}`
      );
    }

    // ── Global queue-size guard ─────────────────────────────────
    // Every scheduled post is a delayed job in Redis (noeviction, 224 MB).
    // If Redis fills up, enqueue AND the worker's own writes start failing
    // for everybody — so refuse new uploads long before that.
    const MAX_PENDING_POSTS = parseInt(process.env.MAX_PENDING_POSTS || "150000", 10);
    const pendingNow = await prisma.post.count({
      where: { status: { in: ["scheduled", "pending"] } },
    });
    if (pendingNow + records.length > MAX_PENDING_POSTS) {
      throw new ValidationError(
        `The queue is full (${pendingNow} posts already scheduled, limit ${MAX_PENDING_POSTS}). ` +
          `Wait for some posts to publish, or upload a smaller file.`
      );
    }

    // ── Keep a copy of the upload (best effort) ─────────────────
    // Only used for retention/cleanup — a storage problem (volume
    // permissions, disk full) must NOT block the upload.
    stage = "save";
    const jobId = crypto.randomUUID();
    const ext = sheet.format === "xlsx" ? "xlsx" : "csv";
    const filename = `${jobId}.${ext}`;
    try {
      const uploadDir = path.join("/app/uploads", userId, jobId);
      await mkdir(uploadDir, { recursive: true });
      const target = path.join(uploadDir, filename);
      await writeFile(target, buffer);
      filePath = target;
    } catch (saveErr) {
      console.warn("[upload] could not store a copy of the file (continuing):", saveErr);
    }

    // ── Build every Post + comment row up-front ─────────────────
    const postRows = records.map((row, index) => {
      const ptype = row.post_type.toLowerCase().trim();
      const type = ptype || "image";
      const caption = row.caption.replace(CONTROL_CHARS_RE, "");
      const mediaUrl = row.media_url.replace(ALL_CONTROL_RE, "");
      const c1 = row.comment_1.trim();
      const d1 = parseDelay(row.comment_1_delay_minutes) ?? 0;
      // Immediate comment_1 is stored on the post (worker queues it right
      // after publishing); a delayed one becomes a ScheduledComment below.
      const comment = c1 && d1 <= 0 ? c1.replace(CONTROL_CHARS_RE, "") : null;

      const id = crypto.randomUUID();
      const scheduledAt = new Date(startAt.getTime() + index * intervalMinutes * 60_000);
      return {
        id,
        jobId,
        userId,
        accountId,
        caption,
        mediaUrl,
        postType: type,
        comment,
        csvRowIndex: index,
        status: "scheduled" as const,
        scheduledAt,
        bullJobId: id, // postId doubles as the BullMQ jobId (idempotency)
      };
    });

    const scheduledCommentRows: { postId: string; message: string; delayMinutes: number }[] = [];
    records.forEach((row, index) => {
      const post = postRows[index];
      const c1 = row.comment_1.trim();
      const d1 = parseDelay(row.comment_1_delay_minutes) ?? 0;
      if (c1 && d1 > 0) {
        scheduledCommentRows.push({
          postId: post.id,
          message: c1.replace(CONTROL_CHARS_RE, ""),
          delayMinutes: d1,
        });
      }
      const c2 = row.comment_2.trim();
      if (c2) {
        scheduledCommentRows.push({
          postId: post.id,
          message: c2.replace(CONTROL_CHARS_RE, ""),
          delayMinutes: parseDelay(row.comment_2_delay_minutes) as number,
        });
      }
    });

    // ── Job + Posts + delayed comments in ONE transaction ───────
    // Comments are written BEFORE enqueue so that a post which fires
    // immediately always finds its comment rows.
    stage = "db";
    const createdJob = await prisma.$transaction(
      async (tx) => {
        const job = await tx.job.create({
          data: {
            // MUST be the same id the Post rows reference (postRows[].jobId).
            // Without it Prisma generates its own cuid and every Post insert
            // fails the Post→Job foreign key (Prisma P2003).
            id: jobId,
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
        await tx.post.createMany({ data: postRows });
        if (scheduledCommentRows.length > 0) {
          await tx.scheduledComment.createMany({
            data: scheduledCommentRows.map((c) => ({ ...c, accountId })),
          });
        }
        return job;
      },
      { maxWait: 10_000, timeout: 60_000 }
    );
    createdJobId = createdJob.id;

    // ── Enqueue all posts into BullMQ (batched addBulk) ─────────
    stage = "queue";
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
    enqueuePayload = postRows.map((p) => ({
      id: p.id,
      postType: p.postType,
      scheduledAt: p.scheduledAt,
    }));

    try {
      await enqueueJobPosts(redis, postsToEnqueue);
      enqueued = true;
    } catch (enqueueErr) {
      // Roll the whole job back — no half-scheduled uploads.
      console.error("[upload] enqueue failed — rolling back job", enqueueErr);
      try {
        await cancelJobPostsByIds(redis, enqueuePayload);
      } catch {
        // best effort — the job delete below still removes DB state
      }
      await prisma.job.delete({ where: { id: createdJob.id } }); // cascades posts + comments
      createdJobId = null;
      throw enqueueErr;
    }

    // Job is live from the API's perspective
    stage = "db";
    await prisma.job.update({
      where: { id: createdJob.id },
      data: { status: "running", startedAt: new Date() },
    });

    const finalJob = await prisma.job.findUniqueOrThrow({
      where: { id: createdJob.id },
      include: { account: { select: { id: true, name: true } } },
    });

    return NextResponse.json(
      {
        success: true,
        job: serializeJob(finalJob),
        format: sheet.format,
        rows: records.length,
        warnings: sheet.warnings,
      },
      { status: 201 }
    );
  } catch (err: any) {
    // Clean up the stored copy on error
    if (filePath) {
      try {
        const { unlink } = await import("node:fs/promises");
        await unlink(filePath);
      } catch {
        // best effort
      }
    }
    // If the job row exists but was never enqueued, remove it. Once
    // `enqueued` is true the job is LIVE — a later error must NOT delete it.
    if (createdJobId && !enqueued) {
      try {
        await prisma.job.delete({ where: { id: createdJobId } });
      } catch {
        // already deleted or never committed — fine
      }
    }

    if (err instanceof AuthError || err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    // requireAccount() throws NotFound/Forbidden with a status
    if (typeof err?.status === "number" && err.status >= 400 && err.status < 500 && err.message) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }

    console.error(`[upload] unexpected failure at stage "${stage}"`, err);
    const code = err?.code || err?.name || "unknown";
    const hint =
      stage === "db"
        ? /^P20(21|22)$/.test(String(err?.code))
          ? "The database is not migrated — restart the web container so `prisma migrate deploy` runs."
          : "Database error while saving. Please try again."
        : stage === "queue"
          ? "The job queue (Redis) is not reachable. Please try again in a minute."
          : "Please check the file and try again.";
    return NextResponse.json(
      { error: `Could not process this file. ${hint} [ref: ${stage}/${code}]` },
      { status: 500 }
    );
  } finally {
    releaseSlot?.();
  }
}

// Import serializeJob for the response
import { serializeJob } from "@/lib/ownership";
