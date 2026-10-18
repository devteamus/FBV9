"use client";
/**
 * Daily Overview (Features 1 + 6) — account-wise daily post overview and
 * daily activity summary.
 *
 * All numbers come from GET /api/analytics (real DB counts — nothing
 * estimated). Date filters: today / yesterday / last 7 days / custom.
 * The summary cards always cover ALL accounts; the table can be scoped
 * to one account.
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import {
  AlertTriangle,
  CheckCircle,
  Clock,
  ExternalLink,
  FileWarning,
  MessageSquare,
  MessageSquareWarning,
  RefreshCw,
  Timer,
} from "lucide-react";
import {
  DateRangePicker,
  LoadingRow,
  EmptyRow,
  PageAvatar,
  Pagination,
  formatDateTime,
  formatRelative,
  rangeToQuery,
  type RangeSelection,
} from "@/components/ui-kit";

interface AccountRow {
  id: string;
  name: string;
  fbPageId: string;
  pictureUrl: string | null;
  isActive: boolean;
  postsPublished: number;
  postsScheduled: number;
  postsFailed: number;
  commentsPublished: number;
  commentsFailed: number;
  commentsPending: number;
  commentsNeedsReview: number;
  missingComments: number;
  lastPublishAt: string | null;
  nextScheduledAt: string | null;
}

interface AnalyticsData {
  range: { from: string; to: string; preset: string };
  accounts: AccountRow[];
  totals: {
    accounts: number;
    postsPublished: number;
    postsScheduled: number;
    postsFailed: number;
    commentsPublished: number;
    commentsFailed: number;
    commentsPending: number;
    commentsNeedsReview: number;
    missingComments: number;
  };
  recentErrors: Array<{
    type: "post" | "comment";
    accountId: string;
    accountName: string;
    postCaption: string;
    message: string;
    at: string;
  }>;
}

export default function AnalyticsPage() {
  const [range, setRange] = useState<RangeSelection>({ preset: "today" });
  const [accountFilter, setAccountFilter] = useState<string>("");
  const [accounts, setAccounts] = useState<Array<{ id: string; name: string }>>([]);
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .listAccounts()
      .then((a) => setAccounts(a))
      .catch(() => {});
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    api
      .analytics({ ...rangeToQuery(range), account_id: accountFilter || undefined })
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message || "Failed to load analytics");
        setLoading(false);
      });
  }, [range, accountFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const cards = [
    {
      label: "Posts published",
      value: data?.totals.postsPublished ?? 0,
      icon: CheckCircle,
      color: "text-green-500",
      hint: "in selected range",
    },
    {
      label: "Posts failed",
      value: data?.totals.postsFailed ?? 0,
      icon: FileWarning,
      color: "text-red-500",
      hint: "due in range",
    },
    {
      label: "Scheduled (upcoming)",
      value: data?.totals.postsScheduled ?? 0,
      icon: Clock,
      color: "text-blue-500",
      hint: "current backlog",
    },
    {
      label: "Comments published",
      value: data?.totals.commentsPublished ?? 0,
      icon: MessageSquare,
      color: "text-green-500",
      hint: "in selected range",
    },
    {
      label: "Comments failed",
      value: data?.totals.commentsFailed ?? 0,
      icon: MessageSquareWarning,
      color: "text-red-500",
      hint: "current",
    },
    {
      label: "Comments pending",
      value: data?.totals.commentsPending ?? 0,
      icon: Timer,
      color: "text-blue-500",
      hint: "current",
    },
    {
      label: "Needs review",
      value: data?.totals.commentsNeedsReview ?? 0,
      icon: AlertTriangle,
      color: "text-amber-500",
      hint: "uncertain outcomes",
    },
    {
      label: "Missing comments",
      value: data?.totals.missingComments ?? 0,
      icon: MessageSquareWarning,
      color: "text-red-600",
      hint: "on published posts",
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Daily Overview</h1>
          <p className="text-sm text-muted-foreground">
            Account-wise posting and comment activity{" "}
            {data ? `· ${new Date(data.range.from).toLocaleDateString()} → ${new Date(
              data.range.to
            ).toLocaleDateString()}` : ""}
          </p>
        </div>
        <button
          onClick={load}
          className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted"
          title="Refresh"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <DateRangePicker value={range} onChange={setRange} allowAll={false} />
        <select
          value={accountFilter}
          onChange={(e) => setAccountFilter(e.target.value)}
          className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Filter by account"
        >
          <option value="">All accounts (table)</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {/* Summary cards (always ALL accounts) */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="rounded-xl border bg-card p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">{c.label}</p>
              <c.icon className={`h-4 w-4 ${c.color}`} />
            </div>
            <p className="mt-1.5 text-2xl font-semibold tabular-nums">{c.value}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{c.hint}</p>
          </div>
        ))}
      </div>

      {/* Account-wise table */}
      <div className="rounded-xl border bg-card shadow-sm overflow-x-auto">
        <div className="border-b px-6 py-4">
          <h2 className="text-sm font-semibold">Account-wise performance</h2>
          <p className="text-xs text-muted-foreground">
            Published/failed columns follow the selected date range; scheduled, pending and
            review columns show the current state.
          </p>
        </div>
        <table className="w-full min-w-[1080px] text-sm">
          <thead>
            <tr className="border-b bg-muted/50 text-left">
              <th className="px-6 py-3 font-medium text-muted-foreground">Account</th>
              <th className="px-4 py-3 font-medium text-muted-foreground">Published</th>
              <th className="px-4 py-3 font-medium text-muted-foreground">Scheduled</th>
              <th className="px-4 py-3 font-medium text-muted-foreground">Failed</th>
              <th className="px-4 py-3 font-medium text-muted-foreground">Comments ✓</th>
              <th className="px-4 py-3 font-medium text-muted-foreground">Comments ✗ / pending</th>
              <th className="px-4 py-3 font-medium text-muted-foreground">Missing</th>
              <th className="px-4 py-3 font-medium text-muted-foreground">Last publish</th>
              <th className="px-4 py-3 font-medium text-muted-foreground">Next scheduled</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <LoadingRow colSpan={9} />
            ) : !data || data.accounts.length === 0 ? (
              <EmptyRow
                colSpan={9}
                label="No accounts connected yet — add one on the Accounts page."
              />
            ) : (
              data.accounts.map((a) => (
                <tr key={a.id} className="hover:bg-muted/30">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <PageAvatar name={a.name} pictureUrl={a.pictureUrl} />
                      <div className="min-w-0">
                        <p className="truncate font-medium">{a.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {a.fbPageId}
                          {!a.isActive && (
                            <span className="ml-1 rounded bg-gray-200 px-1 text-[10px] text-gray-600">
                              inactive
                            </span>
                          )}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-4 tabular-nums">{a.postsPublished}</td>
                  <td className="px-4 py-4 tabular-nums text-blue-600">{a.postsScheduled}</td>
                  <td className="px-4 py-4 tabular-nums">
                    <span className={a.postsFailed > 0 ? "font-medium text-red-600" : ""}>
                      {a.postsFailed}
                    </span>
                  </td>
                  <td className="px-4 py-4 tabular-nums">{a.commentsPublished}</td>
                  <td className="px-4 py-4 tabular-nums">
                    <span className={a.commentsFailed > 0 ? "font-medium text-red-600" : ""}>
                      {a.commentsFailed}
                    </span>
                    <span className="text-muted-foreground"> / {a.commentsPending}</span>
                  </td>
                  <td className="px-4 py-4 tabular-nums">
                    {a.missingComments > 0 ? (
                      <a
                        href={`/dashboard/comments?account_ids=${a.id}`}
                        className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 font-medium text-red-700 hover:bg-red-100"
                        title="Open in Missing Comments"
                      >
                        {a.missingComments}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </td>
                  <td className="px-4 py-4">
                    <span className="text-xs" title={formatDateTime(a.lastPublishAt)}>
                      {formatRelative(a.lastPublishAt)}
                    </span>
                  </td>
                  <td className="px-4 py-4">
                    <span className="text-xs" title={formatDateTime(a.nextScheduledAt)}>
                      {formatRelative(a.nextScheduledAt)}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Recent publishing errors (Feature 6) */}
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="border-b px-6 py-4">
          <h2 className="text-sm font-semibold">Recent publishing errors</h2>
          <p className="text-xs text-muted-foreground">
            Latest failed posts and comments across the selected accounts.
          </p>
        </div>
        <div className="divide-y">
          {loading ? (
            <p className="px-6 py-8 text-center text-sm text-muted-foreground">Loading…</p>
          ) : !data || data.recentErrors.length === 0 ? (
            <p className="px-6 py-8 text-center text-sm text-muted-foreground">
              No recent errors. Everything looks healthy. 🎉
            </p>
          ) : (
            data.recentErrors.map((e, i) => (
              <div key={i} className="flex items-start gap-3 px-6 py-3">
                <span
                  className={`mt-0.5 inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
                    e.type === "post"
                      ? "bg-red-100 text-red-700"
                      : "bg-amber-100 text-amber-700"
                  }`}
                >
                  {e.type}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">
                    <span className="font-medium">{e.accountName}</span>
                    <span className="text-muted-foreground"> — </span>
                    <span className="text-muted-foreground">
                      {e.postCaption?.slice(0, 60) || "(no caption)"}
                    </span>
                  </p>
                  <p className="truncate text-xs text-red-600" title={e.message}>
                    {e.message}
                  </p>
                </div>
                <span
                  className="shrink-0 text-xs text-muted-foreground"
                  title={formatDateTime(e.at)}
                >
                  {formatRelative(e.at)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
