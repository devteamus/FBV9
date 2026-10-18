"use client";
/**
 * Missing Comments (Feature 4) — the high-priority worklist for posts
 * that published successfully but whose configured comment failed or
 * was never published.
 *
 * Capabilities:
 *  - filter by one or many accounts, by post date, and by comment status
 *  - select individual posts, or all eligible posts of an account
 *  - preview the original post + the pending comment text
 *  - edit the comment text before publishing
 *  - Publish Comment (single) and bulk retry (selected posts)
 *  - per-post success/skip results from the bulk action
 *  - "Mark published" / "Skip" for needs_review items
 *
 * Safety guarantees live in the API + worker: the original post is never
 * republished, succeeded comments are never retried, and retries verify
 * against Facebook before posting (duplicate prevention).
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import {
  CheckCircle2,
  ExternalLink,
  Loader2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Send,
  X,
} from "lucide-react";
import {
  CommentStatusBadge,
  DateRangePicker,
  MediaPreview,
  PageAvatar,
  Pagination,
  formatDateTime,
  formatRelative,
  rangeToQuery,
  type RangeSelection,
} from "@/components/ui-kit";

interface MissingItem {
  commentId: string | null;
  postId: string;
  accountId: string;
  accountName: string;
  pageId: string;
  commentText: string;
  status: string; // failed | needs_review | pending | processing | missing
  source: string;
  errorMessage: string | null;
  attemptCount: number;
  lastAttemptAt: string | null;
  post: {
    id: string;
    caption: string;
    mediaUrl: string;
    postType: string;
    postedAt: string;
    fbPostId: string | null;
    fbLink: string | null;
  };
}

interface BulkResult {
  postId: string;
  queued: number;
  skipped: number;
  details: Array<{
    commentId: string | null;
    text: string;
    status: "queued" | "skipped";
    reason?: string;
  }>;
}

export default function MissingCommentsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…
        </div>
      }
    >
      <MissingCommentsInner />
    </Suspense>
  );
}

function MissingCommentsInner() {
  const searchParams = useSearchParams();

  const [accounts, setAccounts] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [range, setRange] = useState<RangeSelection>({ preset: "all" });
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);

  const [items, setItems] = useState<MissingItem[]>([]);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [selectedPostIds, setSelectedPostIds] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ key: string; text: string } | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [selectingAccount, setSelectingAccount] = useState<string | null>(null);
  const [bulkResults, setBulkResults] = useState<BulkResult[] | null>(null);
  const [bulkSummary, setBulkSummary] = useState("");
  const [actionMessage, setActionMessage] = useState("");

  // Deep link: /dashboard/comments?account_ids=id1,id2
  useEffect(() => {
    const param = searchParams.get("account_ids");
    if (param) {
      setSelectedAccounts(
        param
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      );
    }
  }, [searchParams]);

  useEffect(() => {
    api
      .listAccounts()
      .then((a) => setAccounts(a))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setPage(1);
  }, [selectedAccounts, range, statusFilter]);

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    api
      .listMissingComments({
        account_ids: selectedAccounts.length ? selectedAccounts.join(",") : undefined,
        status: statusFilter !== "all" ? statusFilter : undefined,
        ...rangeToQuery(range),
        page,
        page_size: 20,
      })
      .then((d) => {
        setItems(d.items);
        setPagination(d.pagination);
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message || "Failed to load missing comments");
        setLoading(false);
      });
  }, [selectedAccounts, statusFilter, range, page]);

  useEffect(() => {
    load();
  }, [load]);

  // ── Account multi-select helpers ─────────────────────────────
  const toggleAccount = (id: string) => {
    setSelectedAccounts((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  // ── Selection ────────────────────────────────────────────────
  const togglePost = (postId: string) => {
    setSelectedPostIds((prev) => {
      const next = new Set(prev);
      if (next.has(postId)) next.delete(postId);
      else next.add(postId);
      return next;
    });
  };

  const pagePostIds = useMemo(() => Array.from(new Set(items.map((i) => i.postId))), [items]);
  const allPageSelected =
    pagePostIds.length > 0 && pagePostIds.every((id) => selectedPostIds.has(id));

  const selectAllPage = () => {
    setSelectedPostIds((prev) => {
      const next = new Set(prev);
      if (allPageSelected) pagePostIds.forEach((id) => next.delete(id));
      else pagePostIds.forEach((id) => next.add(id));
      return next;
    });
  };

  /**
   * Select ALL eligible posts for one account — walks the missing-comments
   * pagination for that account (max 500 posts) and marks every postId.
   */
  const selectAllForAccount = async (accountId: string) => {
    setSelectingAccount(accountId);
    setError("");
    try {
      const collected = new Set<string>();
      let p = 1;
      for (;;) {
        const d = await api.listMissingComments({
          account_ids: accountId,
          status: statusFilter !== "all" ? statusFilter : undefined,
          ...rangeToQuery(range),
          page: p,
          page_size: 100,
        });
        d.items.forEach((i) => collected.add(i.postId));
        if (p >= d.pagination.totalPages || p >= 5) break; // safety cap 500
        p++;
      }
      setSelectedPostIds((prev) => {
        const next = new Set(prev);
        collected.forEach((id) => next.add(id));
        return next;
      });
    } catch (e: any) {
      setError(e.message || "Could not select all posts for this account");
    } finally {
      setSelectingAccount(null);
    }
  };

  // ── Single publish ───────────────────────────────────────────
  const publishSingle = async (item: MissingItem, message?: string) => {
    const key = item.commentId ?? item.postId;
    setBusyKey(key);
    setActionMessage("");
    setError("");
    try {
      const r = item.commentId
        ? await api.publishComment(item.commentId, message)
        : await api.publishPostComment(item.postId, message);
      setActionMessage(
        `Comment queued for publishing (attempt ${r.attempt}). The worker will publish it shortly.`
      );
      setEditing(null);
      setTimeout(load, 2500);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusyKey(null);
    }
  };

  const markPublished = async (item: MissingItem) => {
    if (!item.commentId) return;
    if (
      !confirm(
        "Confirm you opened the post on Facebook and the comment is already there. " +
          "This only records the fact — nothing will be published."
      )
    )
      return;
    setBusyKey(item.commentId);
    setActionMessage("");
    try {
      await api.markCommentPublished(item.commentId);
      setActionMessage("Comment marked as published.");
      setTimeout(load, 1500);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusyKey(null);
    }
  };

  const skip = async (item: MissingItem) => {
    if (!item.commentId) return;
    if (!confirm("Skip this comment? It will stop appearing in this worklist.")) return;
    setBusyKey(item.commentId);
    setActionMessage("");
    try {
      await api.skipComment(item.commentId);
      setActionMessage("Comment skipped.");
      setTimeout(load, 1500);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusyKey(null);
    }
  };

  // ── Bulk retry ──────────────────────────────────────────────
  const bulkRetry = async () => {
    const postIds = Array.from(selectedPostIds);
    if (postIds.length === 0) return;
    if (
      !confirm(
        `Retry eligible comments for ${postIds.length} selected post(s)?\n\n` +
          "Already-published comments are never retried and the posts themselves are never republished."
      )
    )
      return;
    setBulkBusy(true);
    setBulkResults(null);
    setBulkSummary("");
    setError("");
    try {
      const r = await api.bulkRetryComments(postIds);
      setBulkResults(r.results);
      setBulkSummary(
        `${r.totalQueued} comment(s) queued for retry · ${r.totalSkipped} skipped (already published / not due / not eligible)`
      );
      setSelectedPostIds(new Set());
      setTimeout(load, 4000);
    } catch (e: any) {
      setError(e.message || "Bulk retry failed");
    } finally {
      setBulkBusy(false);
    }
  };

  const accountsInResult = useMemo(() => {
    const map = new Map<string, { id: string; name: string; count: number }>();
    for (const i of items) {
      const cur = map.get(i.accountId);
      if (cur) cur.count++;
      else map.set(i.accountId, { id: i.accountId, name: i.accountName, count: 1 });
    }
    return Array.from(map.values());
  }, [items]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Missing Comments</h1>
          <p className="text-sm text-muted-foreground">
            Published posts whose comment failed or never went out — review, edit, retry
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
      <div className="space-y-3 rounded-xl border bg-card p-4 shadow-sm">
        <DateRangePicker value={range} onChange={setRange} />

        {/* Account multi-select */}
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Accounts (select one or many)</p>
          <div className="flex flex-wrap gap-1.5">
            {accounts.length === 0 ? (
              <span className="text-sm text-muted-foreground">No accounts connected.</span>
            ) : (
              accounts.map((a) => {
                const selected = selectedAccounts.includes(a.id);
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => toggleAccount(a.id)}
                    className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                      selected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {selected ? "✓ " : ""}
                    {a.name}
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Filter by comment status"
          >
            <option value="all">All missing kinds</option>
            <option value="failed">Failed</option>
            <option value="needs_review">Needs review</option>
            <option value="pending">Overdue pending</option>
            <option value="processing">Stuck processing</option>
          </select>
        </div>
      </div>

      {error && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {actionMessage && (
        <p className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm text-primary">
          {actionMessage}
        </p>
      )}

      {/* Per-account "select all" + bulk bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Select all eligible of:</span>
          {accountsInResult.length === 0 ? (
            <span className="text-xs text-muted-foreground">—</span>
          ) : (
            accountsInResult.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => selectAllForAccount(a.id)}
                disabled={selectingAccount !== null}
                className="inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
                title={`Select every eligible post of ${a.name}`}
              >
                {selectingAccount === a.id ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-3 w-3" />
                )}
                {a.name} ({a.count})
              </button>
            ))
          )}
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={selectAllPage}
            className="text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            {allPageSelected ? "Clear page" : "Select page"}
          </button>
          <button
            onClick={bulkRetry}
            disabled={bulkBusy || selectedPostIds.size === 0}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {bulkBusy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RotateCcw className="h-4 w-4" />
            )}
            Retry comments ({selectedPostIds.size} post{selectedPostIds.size === 1 ? "" : "s"})
          </button>
        </div>
      </div>

      {/* Bulk results */}
      {bulkResults && (
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 shadow-sm">
          <div className="mb-2 flex items-start justify-between gap-2">
            <p className="text-sm font-medium text-primary">{bulkSummary}</p>
            <button
              onClick={() => setBulkResults(null)}
              className="rounded p-1 text-muted-foreground hover:bg-muted"
              aria-label="Close results"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="max-h-64 space-y-1.5 overflow-y-auto">
            {bulkResults.map((r) => (
              <div key={r.postId} className="rounded-lg border bg-card px-3 py-2">
                <p className="text-xs font-medium">
                  Post {r.postId} — {r.queued} queued / {r.skipped} skipped
                </p>
                {r.details.map((d, i) => (
                  <p
                    key={i}
                    className={`text-xs ${d.status === "queued" ? "text-green-700" : "text-muted-foreground"}`}
                  >
                    {d.status === "queued" ? "✓" : "–"} {d.text.slice(0, 80)}
                    {d.reason ? ` · ${d.reason}` : ""}
                  </p>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Missing comment items */}
      {loading ? (
        <div className="flex items-center justify-center rounded-xl border bg-card py-16 text-sm text-muted-foreground shadow-sm">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading missing comments…
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border bg-card px-6 py-16 text-center shadow-sm">
          <CheckCircle2 className="mx-auto mb-2 h-10 w-10 text-green-500 opacity-60" />
          <p className="text-sm font-medium">No missing comments</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Every comment on your published posts either went out or is still within its
            schedule window.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            const key = item.commentId ?? `post-${item.postId}`;
            const isEditing = editing?.key === key;
            return (
              <div
                key={key}
                className={`rounded-xl border bg-card shadow-sm transition-colors ${
                  selectedPostIds.has(item.postId) ? "ring-1 ring-primary" : ""
                }`}
              >
                <div className="flex flex-col gap-4 p-4 sm:flex-row">
                  {/* Checkbox */}
                  <input
                    type="checkbox"
                    checked={selectedPostIds.has(item.postId)}
                    onChange={() => togglePost(item.postId)}
                    className="mt-1 h-4 w-4 shrink-0"
                    aria-label="Select post for bulk retry"
                  />

                  {/* Post preview */}
                  <MediaPreview
                    mediaUrl={item.post.mediaUrl}
                    postType={item.post.postType}
                    className="h-20 w-20 shrink-0"
                  />

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <PageAvatar name={item.accountName} size={20} />
                      <span className="text-sm font-medium">{item.accountName}</span>
                      <CommentStatusBadge status={item.status} />
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {item.source === "immediate" ? "immediate comment" : "delayed comment"}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        attempt {item.attemptCount}
                        {item.lastAttemptAt ? ` · last try ${formatRelative(item.lastAttemptAt)}` : ""}
                      </span>
                    </div>

                    <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">
                      Post: {item.post.caption || "(no caption)"}
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      Published {formatDateTime(item.post.postedAt)}
                      {item.post.fbLink && (
                        <a
                          href={item.post.fbLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-2 inline-flex items-center gap-0.5 text-primary hover:underline"
                        >
                          <ExternalLink className="h-3 w-3" /> view post
                        </a>
                      )}
                    </p>

                    {/* Pending comment text */}
                    {isEditing ? (
                      <div className="mt-2 space-y-2">
                        <textarea
                          value={editing.text}
                          onChange={(e) => setEditing({ key, text: e.target.value })}
                          rows={3}
                          maxLength={2000}
                          className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          placeholder="Comment text"
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={() => publishSingle(item, editing.text)}
                            disabled={busyKey === key || !editing.text.trim()}
                            className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                          >
                            {busyKey === key ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Send className="h-3.5 w-3.5" />
                            )}
                            Save & publish
                          </button>
                          <button
                            onClick={() => setEditing(null)}
                            className="rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-muted"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                          Pending comment
                        </p>
                        <p className="whitespace-pre-wrap break-words text-sm">
                          {item.commentText}
                        </p>
                      </div>
                    )}

                    {item.errorMessage && (
                      <p className="mt-1.5 rounded bg-red-50 px-2 py-1 text-xs text-red-600">
                        {item.errorMessage}
                      </p>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex shrink-0 flex-row flex-wrap gap-1 sm:flex-col">
                    <button
                      onClick={() =>
                        setEditing(isEditing ? null : { key, text: item.commentText })
                      }
                      className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted"
                      title="Edit comment before publishing"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      Edit
                    </button>
                    <button
                      onClick={() => publishSingle(item)}
                      disabled={busyKey === key}
                      className="inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                      title="Publish this comment now"
                    >
                      {busyKey === key ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Send className="h-3.5 w-3.5" />
                      )}
                      Publish comment
                    </button>
                    {item.commentId && item.status === "needs_review" && (
                      <button
                        onClick={() => markPublished(item)}
                        disabled={busyKey === item.commentId}
                        className="inline-flex items-center gap-1 rounded-lg border border-green-600/40 px-2.5 py-1.5 text-xs font-medium text-green-700 hover:bg-green-50 disabled:opacity-50"
                        title="I verified on Facebook that this comment exists"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Mark published
                      </button>
                    )}
                    {item.commentId && (
                      <button
                        onClick={() => skip(item)}
                        disabled={busyKey === item.commentId}
                        className="rounded-lg border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
                        title="Stop retrying this comment"
                      >
                        Skip
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      <div className="flex justify-center">
        <Pagination
          page={pagination.page}
          totalPages={pagination.totalPages}
          total={pagination.total}
          onPage={setPage}
        />
      </div>
    </div>
  );
}
