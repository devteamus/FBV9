/**
 * GET /api/comments/missing — Missing Comment worklist (Feature 4).
 *
 * Finds published posts whose configured comment has NOT been
 * successfully published, from two detection paths:
 *
 *  A. Tracked comment rows (ScheduledComment) on published posts:
 *     - status failed / needs_review            → missing
 *     - status pending  but overdue             → missing
 *       (expected fire time = post.postedAt + delayMinutes, 5 min grace)
 *     - status processing but stale (>10 min)   → missing (worker died)
 *  B. Crash edge: post is published, has a configured CSV comment,
 *     commentPosted = false, and NO immediate comment row exists at all
 *     (worker died between publishing the post and creating the row).
 *     5 minute grace on post.postedAt.
 *
 * Query params:
 *   account_ids — comma-separated list (one or many accounts)
 *   preset/from/to — date filter on the post's publish date
 *                    (today|yesterday|last7|custom|all, default all)
 *   status      — all (default) | failed | needs_review | pending | processing
 *   page, page_size — pagination (default 1 / 20, max 100)
 *
 * Each item carries the FULL binding triple required for a safe retry:
 * account id + published FB post id + comment text, plus the post
 * preview (caption, media, permalink).
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, AuthError, ValidationError } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parseDateRange, DateRangeError } from "@/lib/date-range";
import { Prisma } from "@prisma/client";

const STATUS_FILTERS = ["all", "failed", "needs_review", "pending", "processing"];

interface MissingRow {
  comment_id: string | null;
  post_id: string;
  account_id: string;
  account_name: string;
  page_id: string;
  message: string;
  status: string;
  source: string;
  error_message: string | null;
  attempt_count: number | bigint;
  last_attempt_at: Date | null;
  caption: string;
  media_url: string;
  post_type: string;
  posted_at: Date;
  fb_post_id: string | null;
  total_count: bigint;
}

export async function GET(request: NextRequest) {
  try {
    const { sub: userId } = await getSession();
    const params = request.nextUrl.searchParams;

    // ── Pagination ───────────────────────────────────────────────
    const page = Math.max(1, parseInt(params.get("page") || "1", 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(10, parseInt(params.get("page_size") || "20", 10) || 20)
    );

    // ── Status filter ───────────────────────────────────────────
    const statusFilter = (params.get("status") || "all").toLowerCase();
    if (!STATUS_FILTERS.includes(statusFilter)) {
      throw new ValidationError("Invalid status filter");
    }

    // ── Account filter (multi-select) ────────────────────────────
    const accountIdsRaw = params.get("account_ids") || "";
    let accountIds: string[] = [];
    if (accountIdsRaw.trim()) {
      accountIds = accountIdsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (accountIds.length > 0) {
      // Validate every requested account belongs to the user
      const owned = await prisma.account.findMany({
        where: { id: { in: accountIds }, userId },
        select: { id: true },
      });
      if (owned.length !== accountIds.length) {
        throw new ValidationError("Unknown account in account_ids");
      }
    }

    // ── Date range (defaults to all time) ────────────────────────
    const preset = (params.get("preset") || "all").toLowerCase();
    let dateFrom: Date | null = null;
    let dateTo: Date | null = null;
    if (preset !== "all") {
      const url = new URLSearchParams({ preset });
      if (preset === "custom") {
        const from = params.get("from");
        const to = params.get("to");
        if (from) url.set("from", from);
        if (to) url.set("to", to);
      }
      const range = parseDateRange(url);
      dateFrom = range.from;
      dateTo = range.to;
    }

    // ── Compose the SQL ──────────────────────────────────────────
    const userFilter = Prisma.sql`m.user_id = ${userId}`;
    const accountFilter =
      accountIds.length > 0
        ? Prisma.sql`AND m.account_id IN (${Prisma.join(accountIds)})`
        : Prisma.empty;
    const dateFilter =
      dateFrom && dateTo
        ? Prisma.sql`AND m.posted_at >= ${dateFrom} AND m.posted_at <= ${dateTo}`
        : Prisma.empty;
    const statusSql =
      statusFilter === "all"
        ? Prisma.empty
        : statusFilter === "failed"
          ? Prisma.sql`AND m.status IN ('failed', 'needs_review', 'missing')`
          : Prisma.sql`AND m.status = ${statusFilter}`;

    const rows = (await prisma.$queryRaw<MissingRow[]>(Prisma.sql`
      WITH missing AS (
        -- Path A: tracked comment rows on published posts that are not
        -- successfully published (failed, needs review, overdue pending,
        -- or stale processing)
        SELECT
          sc."id"            AS comment_id,
          sc."postId"        AS post_id,
          p."userId"         AS user_id,
          p."accountId"      AS account_id,
          a."name"           AS account_name,
          a."fbPageId"       AS page_id,
          sc."message"       AS message,
          CASE
            WHEN sc."status" = 'processing' THEN 'processing'
            ELSE sc."status"
          END                AS status,
          sc."source"        AS source,
          sc."errorMessage"  AS error_message,
          sc."attemptCount"  AS attempt_count,
          sc."lastAttemptAt" AS last_attempt_at,
          p."caption"        AS caption,
          p."mediaUrl"       AS media_url,
          p."postType"       AS post_type,
          p."postedAt"       AS posted_at,
          p."fbPostId"       AS fb_post_id
        FROM "ScheduledComment" sc
        JOIN "Post" p ON p."id" = sc."postId"
        JOIN "Account" a ON a."id" = p."accountId"
        WHERE p."status" = 'posted'
          AND p."fbPostId" IS NOT NULL
          AND (
            sc."status" IN ('failed', 'needs_review')
            OR (
              sc."status" = 'pending'
              AND p."postedAt" + make_interval(mins => sc."delayMinutes")
                  < now() - interval '5 minutes'
            )
            OR (
              sc."status" = 'processing'
              AND sc."lastAttemptAt" < now() - interval '10 minutes'
            )
          )

        UNION ALL

        -- Path B: crash edge — published post with a configured comment,
        -- never marked posted, and no immediate comment row at all
        SELECT
          NULL::text         AS comment_id,
          p."id"             AS post_id,
          p."userId"         AS user_id,
          p."accountId"      AS account_id,
          a."name"           AS account_name,
          a."fbPageId"       AS page_id,
          p."comment"        AS message,
          'missing'          AS status,
          'immediate'        AS source,
          p."commentError"   AS error_message,
          0                  AS attempt_count,
          NULL::timestamp    AS last_attempt_at,
          p."caption"        AS caption,
          p."mediaUrl"       AS media_url,
          p."postType"       AS post_type,
          p."postedAt"       AS posted_at,
          p."fbPostId"       AS fb_post_id
        FROM "Post" p
        JOIN "Account" a ON a."id" = p."accountId"
        WHERE p."status" = 'posted'
          AND p."fbPostId" IS NOT NULL
          AND p."comment" IS NOT NULL
          AND p."commentPosted" = false
          AND p."postedAt" < now() - interval '5 minutes'
          AND NOT EXISTS (
            SELECT 1 FROM "ScheduledComment" x
            WHERE x."postId" = p."id" AND x."source" = 'immediate'
          )
      )
      SELECT
        m.*,
        COUNT(*) OVER() AS total_count
      FROM missing m
      WHERE ${userFilter}
        ${accountFilter}
        ${dateFilter}
        ${statusSql}
      ORDER BY m.posted_at DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `)) as unknown as MissingRow[];

    const total = rows.length > 0 ? Number(rows[0].total_count) : 0;

    const items = rows.map((r) => ({
      commentId: r.comment_id,
      postId: r.post_id,
      accountId: r.account_id,
      accountName: r.account_name,
      pageId: r.page_id,
      commentText: r.message,
      status: r.status, // failed | needs_review | pending | processing | missing
      source: r.source, // immediate | csv_delayed
      errorMessage: r.error_message,
      attemptCount: Number(r.attempt_count),
      lastAttemptAt: r.last_attempt_at
        ? new Date(r.last_attempt_at).toISOString()
        : null,
      post: {
        id: r.post_id,
        caption: r.caption,
        mediaUrl: r.media_url,
        postType: r.post_type,
        postedAt: new Date(r.posted_at).toISOString(),
        fbPostId: r.fb_post_id,
        fbLink: r.fb_post_id ? `https://www.facebook.com/${r.fb_post_id}` : null,
      },
    }));

    return NextResponse.json({
      items,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof ValidationError || err instanceof DateRangeError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("[comments:missing]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
