/**
 * GET /api/posts — paginated post previews across all connected accounts
 * (Feature 2: Published Post Preview).
 *
 * Query params:
 *   account_id   — filter by a single account
 *   post_type    — text | image | video | reel
 *   status       — posted (default) | scheduled | pending | failed | deleted | all
 *   comment_status — published | missing | pending | none (see deriveCommentStatus)
 *   preset       — today | yesterday | last7 | custom | all (default: all)
 *   from, to     — YYYY-MM-DD when preset=custom
 *   page         — 1-based page number (default 1)
 *   page_size    — 10..100 (default 20)
 *
 * Each item carries the account context, media url, fb permalink, and a
 * comment summary computed from the tracked ScheduledComment rows.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, AuthError, ValidationError } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parseDateRange, DateRangeError } from "@/lib/date-range";
import { serializePublishedPost } from "@/lib/ownership";
import type { Prisma } from "@prisma/client";

const POST_STATUSES = ["posted", "scheduled", "pending", "posting", "failed", "deleted"];
const POST_TYPES = ["text", "image", "video", "reel"];
const COMMENT_STATUSES = ["published", "missing", "pending", "none"];

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

    // ── Filters ──────────────────────────────────────────────────
    const accountId = params.get("account_id") || undefined;
    if (accountId) {
      const owned = await prisma.account.findFirst({
        where: { id: accountId, userId },
        select: { id: true },
      });
      if (!owned) throw new ValidationError("Unknown account");
    }

    const postType = params.get("post_type") || undefined;
    if (postType && !POST_TYPES.includes(postType)) {
      throw new ValidationError("Invalid post_type");
    }

    const statusParam = (params.get("status") || "posted").toLowerCase();
    const status =
      statusParam === "all" ? undefined : statusParam;
    if (status && !POST_STATUSES.includes(status)) {
      throw new ValidationError("Invalid status");
    }

    const commentStatus = params.get("comment_status") || undefined;
    if (commentStatus && !COMMENT_STATUSES.includes(commentStatus)) {
      throw new ValidationError("Invalid comment_status");
    }

    // ── Date range ───────────────────────────────────────────────
    // Applied to postedAt for published posts and to scheduledAt for
    // everything else (a failed/scheduled post has no postedAt).
    const preset = (params.get("preset") || "all").toLowerCase();
    let dateFilter: Prisma.PostWhereInput | undefined;
    if (preset !== "all") {
      const url = new URLSearchParams({ preset });
      if (preset === "custom") {
        const from = params.get("from");
        const to = params.get("to");
        if (from) url.set("from", from);
        if (to) url.set("to", to);
      }
      const range = parseDateRange(url);
      dateFilter = {
        OR: [
          { status: "posted", postedAt: { gte: range.from, lte: range.to } },
          {
            status: { not: "posted" },
            OR: [
              { scheduledAt: { gte: range.from, lte: range.to } },
              { scheduledAt: null, createdAt: { gte: range.from, lte: range.to } },
            ],
          },
        ],
      };
    }

    // ── Comment-status filter (relation predicates) ──────────────
    let commentFilter: Prisma.PostWhereInput | undefined;
    switch (commentStatus) {
      case "published":
        commentFilter = {
          AND: [
            { scheduledComments: { some: {} } },
            { scheduledComments: { every: { status: { in: ["published", "skipped"] } } } },
            { OR: [{ comment: null }, { commentPosted: true }] },
          ],
        };
        break;
      case "missing":
        commentFilter = {
          OR: [
            { scheduledComments: { some: { status: { in: ["failed", "needs_review"] } } } },
            {
              comment: { not: null },
              commentPosted: false,
              scheduledComments: { none: { source: "immediate", status: "published" } },
            },
          ],
        };
        break;
      case "pending":
        commentFilter = {
          AND: [
            { scheduledComments: { some: { status: { in: ["pending", "processing"] } } } },
            { scheduledComments: { none: { status: { in: ["failed", "needs_review"] } } } },
            { OR: [{ comment: null }, { commentPosted: true }] },
          ],
        };
        break;
      case "none":
        commentFilter = {
          AND: [{ comment: null }, { scheduledComments: { none: {} } }],
        };
        break;
    }

    const where: Prisma.PostWhereInput = {
      userId,
      ...(accountId ? { accountId } : {}),
      ...(postType ? { postType } : {}),
      ...(status ? { status } : {}),
      ...(dateFilter ? dateFilter : {}),
      ...(commentFilter ? commentFilter : {}),
    };

    // ── Query ────────────────────────────────────────────────────
    const [total, posts] = await Promise.all([
      prisma.post.count({ where }),
      prisma.post.findMany({
        where,
        orderBy: [{ postedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          account: {
            select: { id: true, name: true, fbPageId: true, fbPagePictureUrl: true },
          },
        },
      }),
    ]);

    // ── Comment summaries for this page (one grouped query) ─────
    const postIds = posts.map((p) => p.id);
    const commentCounts = postIds.length
      ? await prisma.scheduledComment.groupBy({
          by: ["postId", "status"],
          where: { postId: { in: postIds } },
          _count: { _all: true },
        })
      : [];

    const summaryMap = new Map<
      string,
      { published: number; pending: number; missing: number; total: number }
    >();
    for (const row of commentCounts) {
      let s = summaryMap.get(row.postId);
      if (!s) {
        s = { published: 0, pending: 0, missing: 0, total: 0 };
        summaryMap.set(row.postId, s);
      }
      const n = row._count._all;
      s.total += n;
      if (row.status === "published") s.published += n;
      else if (row.status === "pending" || row.status === "processing") s.pending += n;
      else if (row.status === "failed" || row.status === "needs_review") s.missing += n;
      // 'skipped' rows count toward total but neither published nor missing
    }

    return NextResponse.json({
      posts: posts.map((p) =>
        serializePublishedPost(p, p.account, summaryMap.get(p.id))
      ),
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
    console.error("[posts:list]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
