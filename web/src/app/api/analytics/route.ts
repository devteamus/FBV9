/**
 * GET /api/analytics — Account-wise daily overview + daily activity summary
 * (Features 1 & 6).
 *
 * Query params:
 *   preset   — today (default) | yesterday | last7 | custom
 *   from, to — YYYY-MM-DD, required when preset=custom
 *   account_id — optional: limit the table to a single account
 *                (summary cards always cover ALL accounts)
 *
 * Returns (all numbers are real DB counts — nothing estimated):
 * {
 *   range: { from, to, preset },
 *   accounts: [{
 *     id, name, fbPageId, pictureUrl,
 *     postsPublished,     // postedAt within range
 *     postsScheduled,     // currently pending/scheduled/posting
 *     postsFailed,        // failed, scheduledAt within range
 *     commentsPublished,  // status=published, postedAt within range
 *     commentsFailed,     // currently status=failed
 *     commentsPending,    // currently status=pending/processing
 *     commentsNeedsReview,// currently status=needs_review
 *     lastPublishAt,      // max postedAt (overall, not range-bound)
 *     nextScheduledAt     // earliest upcoming scheduledAt (overall)
 *   }],
 *   totals: { ...same counters summed + accounts count + missingComments },
 *   recentErrors: [{ type, accountId, accountName, postCaption, message, at }]
 * }
 *
 * Counting notes (§ "do not double-count queue retries"):
 *  - posts are counted once per Post row by their terminal/current status;
 *    BullMQ retry attempts never create additional Post rows
 *  - comments are counted once per ScheduledComment row by status;
 *    attemptCount tracks tries but never inflates row counts
 *  - failed posts are anchored by scheduledAt (the window they were due in),
 *    because failed posts have no postedAt
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, AuthError } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parseDateRange, DateRangeError } from "@/lib/date-range";

export async function GET(request: NextRequest) {
  try {
    const { sub: userId } = await getSession();
    const params = request.nextUrl.searchParams;
    const range = parseDateRange(params);

    const accountFilter = params.get("account_id");

    // ── Load the user's accounts ────────────────────────────────
    const accounts = await prisma.account.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        fbPageId: true,
        fbPagePictureUrl: true,
        isActive: true,
      },
    });

    const scopedAccounts = accountFilter
      ? accounts.filter((a) => a.id === accountFilter)
      : accounts;

    const accountIds = scopedAccounts.map((a) => a.id);

    const rangeOut = {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      preset: range.preset,
    };

    if (accountIds.length === 0) {
      return NextResponse.json({
        range: rangeOut,
        accounts: scopedAccounts.map((a) => ({
          id: a.id,
          name: a.name,
          fbPageId: a.fbPageId,
          pictureUrl: a.fbPagePictureUrl,
          isActive: a.isActive,
          postsPublished: 0,
          postsScheduled: 0,
          postsFailed: 0,
          commentsPublished: 0,
          commentsFailed: 0,
          commentsPending: 0,
          commentsNeedsReview: 0,
          missingComments: 0,
          lastPublishAt: null,
          nextScheduledAt: null,
        })),
        totals: {
          accounts: accounts.length,
          postsPublished: 0,
          postsScheduled: 0,
          postsFailed: 0,
          commentsPublished: 0,
          commentsFailed: 0,
          commentsPending: 0,
          commentsNeedsReview: 0,
          missingComments: 0,
        },
        recentErrors: [],
      });
    }

    // ── Post counts, grouped per account (grouped queries) ──────
    const [
      publishedByAccount,
      scheduledByAccount,
      failedByAccount,
      lastPublishPerAccount,
      nextScheduledPerAccount,
    ] = await Promise.all([
      // posts published within range
      prisma.post.groupBy({
        by: ["accountId"],
        where: {
          userId,
          accountId: { in: accountIds },
          status: "posted",
          postedAt: { gte: range.from, lte: range.to },
        },
        _count: { _all: true },
      }),
      // currently scheduled posts (pending/scheduled/posting)
      prisma.post.groupBy({
        by: ["accountId"],
        where: {
          userId,
          accountId: { in: accountIds },
          status: { in: ["pending", "scheduled", "posting"] },
        },
        _count: { _all: true },
      }),
      // posts that failed, anchored by the window they were due in
      prisma.post.groupBy({
        by: ["accountId"],
        where: {
          userId,
          accountId: { in: accountIds },
          status: "failed",
          scheduledAt: { gte: range.from, lte: range.to },
        },
        _count: { _all: true },
      }),
      // last successful publish per account (max postedAt)
      prisma.post.groupBy({
        by: ["accountId"],
        where: { userId, accountId: { in: accountIds }, status: "posted" },
        _max: { postedAt: true },
      }),
      // next scheduled post per account (min upcoming scheduledAt)
      prisma.post.groupBy({
        by: ["accountId"],
        where: {
          userId,
          accountId: { in: accountIds },
          status: { in: ["pending", "scheduled"] },
          scheduledAt: { gt: new Date() },
        },
        _min: { scheduledAt: true },
      }),
    ]);

    const publishedMap = new Map(publishedByAccount.map((g) => [g.accountId, g._count._all]));
    const scheduledMap = new Map(scheduledByAccount.map((g) => [g.accountId, g._count._all]));
    const failedMap = new Map(failedByAccount.map((g) => [g.accountId, g._count._all]));
    const lastPublishMap = new Map(
      lastPublishPerAccount.map((g) => [g.accountId, g._max.postedAt])
    );
    const nextScheduledMap = new Map(
      nextScheduledPerAccount.map((g) => [g.accountId, g._min.scheduledAt])
    );

    // ── Comment counts per account ──────────────────────────────
    const commentsByAccount = await prisma.scheduledComment.groupBy({
      by: ["accountId", "status"],
      where: { accountId: { in: accountIds } },
      _count: { _all: true },
    });
    const commentsPublishedInRange = await prisma.scheduledComment.groupBy({
      by: ["accountId"],
      where: {
        accountId: { in: accountIds },
        status: "published",
        postedAt: { gte: range.from, lte: range.to },
      },
      _count: { _all: true },
    });
    // Missing comments = comments on published posts that are not
    // successfully published (failed / needs_review). Overdue-pending
    // comments are surfaced on the dedicated Missing Comments page.
    const missingByAccount = await prisma.scheduledComment.groupBy({
      by: ["accountId"],
      where: {
        accountId: { in: accountIds },
        status: { in: ["failed", "needs_review"] },
        post: { status: "posted" },
      },
      _count: { _all: true },
    });

    const commentStatusMap = new Map<string, Map<string, number>>();
    for (const g of commentsByAccount) {
      const key = g.accountId ?? "";
      if (!commentStatusMap.has(key)) commentStatusMap.set(key, new Map());
      commentStatusMap.get(key)!.set(g.status, g._count._all);
    }
    const commentsInRangeMap = new Map(
      commentsPublishedInRange.map((g) => [g.accountId ?? "", g._count._all])
    );
    const missingMap = new Map(missingByAccount.map((g) => [g.accountId ?? "", g._count._all]));

    // ── Assemble per-account rows ───────────────────────────────
    const accountRows = scopedAccounts.map((a) => {
      const statusCounts = commentStatusMap.get(a.id);
      return {
        id: a.id,
        name: a.name,
        fbPageId: a.fbPageId,
        pictureUrl: a.fbPagePictureUrl,
        isActive: a.isActive,
        postsPublished: publishedMap.get(a.id) ?? 0,
        postsScheduled: scheduledMap.get(a.id) ?? 0,
        postsFailed: failedMap.get(a.id) ?? 0,
        commentsPublished: commentsInRangeMap.get(a.id) ?? 0,
        commentsFailed: statusCounts?.get("failed") ?? 0,
        commentsPending:
          (statusCounts?.get("pending") ?? 0) + (statusCounts?.get("processing") ?? 0),
        commentsNeedsReview: statusCounts?.get("needs_review") ?? 0,
        missingComments: missingMap.get(a.id) ?? 0,
        lastPublishAt: lastPublishMap.get(a.id)?.toISOString() ?? null,
        nextScheduledAt: nextScheduledMap.get(a.id)?.toISOString() ?? null,
      };
    });

    const totals = {
      accounts: accounts.length, // summary cards always cover ALL accounts
      postsPublished: accountRows.reduce((acc, r) => acc + r.postsPublished, 0),
      postsScheduled: accountRows.reduce((acc, r) => acc + r.postsScheduled, 0),
      postsFailed: accountRows.reduce((acc, r) => acc + r.postsFailed, 0),
      commentsPublished: accountRows.reduce((acc, r) => acc + r.commentsPublished, 0),
      commentsFailed: accountRows.reduce((acc, r) => acc + r.commentsFailed, 0),
      commentsPending: accountRows.reduce((acc, r) => acc + r.commentsPending, 0),
      commentsNeedsReview: accountRows.reduce((acc, r) => acc + r.commentsNeedsReview, 0),
      missingComments: accountRows.reduce((acc, r) => acc + r.missingComments, 0),
    };

    // ── Recent publishing errors (Feature 6) ────────────────────
    const [failedPosts, failedComments] = await Promise.all([
      prisma.post.findMany({
        where: {
          userId,
          accountId: { in: accountIds },
          status: "failed",
          errorMessage: { not: null },
        },
        orderBy: [{ scheduledAt: { sort: "desc", nulls: "last" } }],
        take: 5,
        select: {
          accountId: true,
          errorMessage: true,
          caption: true,
          scheduledAt: true,
          createdAt: true,
          account: { select: { name: true } },
        },
      }),
      prisma.scheduledComment.findMany({
        where: {
          accountId: { in: accountIds },
          status: { in: ["failed", "needs_review"] },
          errorMessage: { not: null },
        },
        orderBy: [{ lastAttemptAt: { sort: "desc", nulls: "last" } }],
        take: 5,
        select: {
          accountId: true,
          errorMessage: true,
          status: true,
          lastAttemptAt: true,
          createdAt: true,
          post: {
            select: { caption: true, account: { select: { name: true } } },
          },
        },
      }),
    ]);

    const accountNameMap = new Map(accounts.map((a) => [a.id, a.name]));
    const recentErrors = [
      ...failedPosts.map((p) => ({
        type: "post" as const,
        accountId: p.accountId,
        accountName: p.account?.name ?? accountNameMap.get(p.accountId) ?? "Unknown",
        postCaption: p.caption,
        message: p.errorMessage ?? "",
        at: (p.scheduledAt ?? p.createdAt).toISOString(),
      })),
      ...failedComments.map((c) => ({
        type: "comment" as const,
        accountId: c.accountId ?? "",
        accountName: c.post.account?.name ?? "Unknown",
        postCaption: c.post.caption,
        message: c.errorMessage ?? "",
        at: (c.lastAttemptAt ?? c.createdAt).toISOString(),
      })),
    ]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 10);

    return NextResponse.json({
      range: rangeOut,
      accounts: accountRows,
      totals,
      recentErrors,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof DateRangeError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("[analytics]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
