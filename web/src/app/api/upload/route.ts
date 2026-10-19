/**
 * POST /api/upload — CSV upload → bulk job creation + BullMQ enqueue
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
import { enqueueJobPosts } from "@/lib/queues/helpers";
import { getRedis } from "@/lib/redis";
import { parse } from "csv-parse/sync";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const VALID_TYPES = new Set(["text", "image", "video", "reel"]);
const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
const ALL_CONTROL_RE = /[\x00-\x1f]/g;

// Rate limit: 20 uploads per hour per IP
const uploadAttempts = new Map<string, { count: number; resetAt: number }>();
const UPLOAD_LIMIT = 20;
const UPLOAD_WINDOW_MS = 60 * 60 * 1000;

function checkUploadRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = uploadAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    uploadAttempts.set(ip, { count: 1, resetAt: now + UPLOAD_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= UPLOAD_LIMIT;
}

export async function POST(request: NextRequest) {
  let filePath: string | null = null;

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
          totalPosts: records.length,
        },
      });

      const postCreates = records.map((row, index) => {
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

        return {
          jobId: job.id,
          userId,
          accountId,
          caption,
          mediaUrl,
          postType: type,
          comment,
          csvRowIndex: index, // preserve CSV order — used for dashboard sorting
          status: "pending" as const,
        };
      });

      // Batch create posts (Prisma createMany for performance)
      if (postCreates.length > 0) {
        await tx.post.createMany({ data: postCreates });
      }

      return job;
    });

    // Enqueue all posts into BullMQ
    const redis = getRedis();
    const allPosts = await prisma.post.findMany({
      where: { jobId: createdJob.id },
      include: { account: { select: { fbPageId: true } } },
      // Order by csvRowIndex — this is the user's CSV upload order.
      // Previously used `createdAt asc`, but Prisma's `createMany` writes
      // all rows in a single statement with the same `now()` timestamp,
      // so createdAt cannot break ties deterministically.
      orderBy: { csvRowIndex: "asc" },
    });

    const startAt = new Date();
    await enqueueJobPosts(
      redis,
      allPosts.map((p, index) => ({
        id: p.id,
        jobId: p.jobId,
        accountId: p.accountId,
        pageId: p.account.fbPageId,
        postType: p.postType,
        index,
        intervalMinutes,
        startAt,
      }))
    );

    // Mark posts as scheduled and job as running
    const now = new Date();
    const scheduledUpdates = allPosts.map((p, i) => {
      const scheduledAt = new Date(startAt.getTime() + i * intervalMinutes * 60_000);
      return prisma.post.update({
        where: { id: p.id },
        data: {
          status: "scheduled",
          scheduledAt: scheduledAt > now ? scheduledAt : now,
          bullJobId: p.id,
        },
      });
    });
    await Promise.all(scheduledUpdates);

    // Create any optional extra delayed comments (comment_2/comment_3
    // columns). Rows that left these blank contribute nothing here —
    // that's the auto-skip behavior. allPosts is in the same order as
    // `records` (both ordered by createdAt asc / CSV row order).
    const scheduledCommentRows: {
      postId: string;
      message: string;
      delayMinutes: number;
    }[] = [];
    records.forEach((row, index) => {
      const post = allPosts[index];
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
