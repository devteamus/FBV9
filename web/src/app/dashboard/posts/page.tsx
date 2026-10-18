"use client";
/**
 * Published Posts (Features 2 + 3) — previews of previously published
 * posts across all connected accounts, with an expandable per-post
 * comment history.
 *
 * Data: GET /api/posts (paginated, filterable), GET /api/posts/[id]/comments
 * (tracked comment history), actions re-use the existing delete-from-
 * Facebook flow plus the new comment retry/publish/mark/skip actions.
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Loader2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Trash2,
  CheckCircle2,
  EyeOff,
} from "lucide-react";
import {
  CommentStatusBadge,
  DateRangePicker,
  MediaPreview,
  PageAvatar,
  Pagination,
  PostStatusBadge,
  formatDateTime,
  formatRelative,
  rangeToQuery,
  type RangeSelection,
} from "@/components/ui-kit";

interface PublishedPost {
  id: string;
  accountId: string;
  accountName: string | null;
  accountPictureUrl: string | null;
  pageId: string | null;
  caption: string;
  mediaUrl: string;
  postType: string;
  comment: string | null;
  status: string;
  postedAt: string | null;
  fbPostId: string | null;
  fbLink: string | null;
  errorMessage: string | null;
  comments: { published: number; pending: number; missing: number; total: number };
  commentStatus: "none" | "published" | "partial" | "pending" | "missing";
}

interface CommentJob {
  id: string;
  postId: string;
  message: string;
  delayMinutes: number;
  source: string;
  status: string;
  fbCommentId: string | null;
  errorMessage: string | null;
  attemptCount: number;
  lastAttemptAt: string | null;
  postedAt: string | null;
  createdAt: string;
}

export default function PublishedPostsPage() {
  const [posts, setPosts] = useState<PublishedPost[]>([]);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, total: 0, totalPages: 1 });
  const [accounts, setAccounts] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // filters
  const [range, setRange] = useState<RangeSelection>({ preset: "all" });
  const [accountFilter, setAccountFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("posted");
  const [commentFilter, setCommentFilter] = useState("");
  const [page, setPage] = useState(1);

  // expanded comment history
  const [expandedPostId, setExpandedPostId] = useState<string | null>(null);
  const [history, setHistory] = useState<CommentJob[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyNote, setHistoryNote] = useState("");

  // per-post action state
  const [busyPostId, setBusyPostId] = useState<string | null>(null);
  const [busyCommentId, setBusyCommentId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState("");
  const [editing, setEditing] = useState<{ commentId: string; text: string } | null>(null);

  useEffect(() => {
    api
      .listAccounts()
      .then((a) => setAccounts(a))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setPage(1);
  }, [range, accountFilter, typeFilter, statusFilter, commentFilter]);

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    api
      .listPublishedPosts({
        ...rangeToQuery(range),
        account_id: accountFilter || undefined,
        post_type: typeFilter || undefined,
        status: statusFilter || undefined,
        comment_status: commentFilter || undefined,
        page,
        page_size: 20,
      })
      .then((d) => {
        setPosts(d.posts);
        setPagination(d.pagination);
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message || "Failed to load posts");
        setLoading(false);
      });
  }, [range, accountFilter, typeFilter, statusFilter, commentFilter, page]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleHistory = async (postId: string) => {
    if (expandedPostId === postId) {
      setExpandedPostId(null);
      setHistory([]);
      return;
    }
    setExpandedPostId(postId);
    setHistoryLoading(true);
    setHistory([]);
    setHistoryNote("");
    try {
      const d = await api.getPostComments(postId);
      setHistory(d.comments);
      setHistoryNote(d.note);
    } catch (e: any) {
      setHistoryNote(e.message || "Failed to load comment history");
    } finally {
      setHistoryLoading(false);
    }
  };

  const refreshHistory = async (postId: string) => {
    try {
      const d = await api.getPostComments(postId);
      setHistory(d.comments);
    } catch {
      /* keep old */
    }
  };

  const deletePostFromFb = async (postId: string) => {
    if (!confirm("Delete this post from Facebook? This cannot be undone.")) return;
    setBusyPostId(postId);
    setActionMessage("");
    try {
      await api.deletePostFromFacebook(postId);
      setActionMessage("Post deletion queued — status will update shortly.");
      setTimeout(load, 4000);
    } catch (e: any) {
      setActionMessage(e.message);
    } finally {
      setBusyPostId(null);
    }
  };

  const retryComment = async (commentId: string, message?: string) => {
    setBusyCommentId(commentId);
    setActionMessage("");
    try {
      const r = await api.publishComment(commentId, message);
      setActionMessage(`Comment queued for publishing (attempt ${r.attempt}).`);
      setEditing(null);
      if (expandedPostId) await refreshHistory(expandedPostId);
    } catch (e: any) {
      setActionMessage(e.message);
    } finally {
      setBusyCommentId(null);
    }
  };

  const markPublished = async (commentId: string) => {
    if (
      !confirm(
        "Confirm you checked the post on Facebook and the comment is there. " +
          "This only records the fact — nothing will be published."
      )
    )
      return;
    setBusyCommentId(commentId);
    setActionMessage("");
    try {
      await api.markCommentPublished(commentId);
      setActionMessage("Comment marked as published.");
      if (expandedPostId) await refreshHistory(expandedPostId);
    } catch (e: any) {
      setActionMessage(e.message);
    } finally {
      setBusyCommentId(null);
    }
  };

  const skipComment = async (commentId: string) => {
    if (!confirm("Skip this comment? It will no longer be retried automatically.")) return;
    setBusyCommentId(commentId);
    setActionMessage("");
    try {
      await api.skipComment(commentId);
      setActionMessage("Comment skipped.");
      if (expandedPostId) await refreshHistory(expandedPostId);
    } catch (e: any) {
      setActionMessage(e.message);
    } finally {
      setBusyCommentId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Published Posts</h1>
          <p className="text-sm text-muted-foreground">
            Preview of your published posts and their automation comment history
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
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <select
            value={accountFilter}
            onChange={(e) => setAccountFilter(e.target.value)}
            className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Filter by account"
          >
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Filter by publishing status"
          >
            <option value="posted">Published</option>
            <option value="scheduled">Scheduled</option>
            <option value="failed">Failed</option>
            <option value="deleted">Deleted</option>
            <option value="all">All statuses</option>
          </select>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Filter by post type"
          >
            <option value="">All types</option>
            <option value="image">Image</option>
            <option value="video">Video</option>
            <option value="reel">Reel</option>
            <option value="text">Text</option>
          </select>
          <select
            value={commentFilter}
            onChange={(e) => setCommentFilter(e.target.value)}
            className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Filter by comment status"
          >
            <option value="">Any comment status</option>
            <option value="published">Comments published</option>
            <option value="missing">Comments missing</option>
            <option value="pending">Comments pending</option>
            <option value="none">No comments</option>
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

      {/* Post list */}
      {loading ? (
        <div className="flex items-center justify-center rounded-xl border bg-card py-16 text-sm text-muted-foreground shadow-sm">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading posts…
        </div>
      ) : posts.length === 0 ? (
        <div className="rounded-xl border bg-card px-6 py-16 text-center text-sm text-muted-foreground shadow-sm">
          <EyeOff className="mx-auto mb-2 h-8 w-8 opacity-40" />
          No posts match these filters.
        </div>
      ) : (
        <div className="space-y-3">
          {posts.map((p) => (
            <div key={p.id} className="rounded-xl border bg-card shadow-sm">
              <div className="flex flex-col gap-4 p-4 sm:flex-row">
                {/* Media preview */}
                <MediaPreview mediaUrl={p.mediaUrl} postType={p.postType} className="h-24 w-24 shrink-0" />

                {/* Body */}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <PageAvatar
                      name={p.accountName ?? "?"}
                      pictureUrl={p.accountPictureUrl}
                      size={20}
                    />
                    <span className="text-sm font-medium">{p.accountName ?? "Unknown"}</span>
                    <PostStatusBadge status={p.status} />
                    {p.commentStatus !== "none" && <CommentStatusBadge status={p.commentStatus} />}
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                      {p.postType}
                    </span>
                  </div>

                  <p className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-sm">
                    {p.caption || <span className="text-muted-foreground">(no caption)</span>}
                  </p>

                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span title={formatDateTime(p.postedAt)}>
                      {p.status === "posted"
                        ? `Published ${formatRelative(p.postedAt)}`
                        : `Status: ${p.status}`}
                    </span>
                    {p.fbPostId && (
                      <a
                        href={p.fbLink ?? "#"}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        <ExternalLink className="h-3 w-3" /> View on Facebook
                      </a>
                    )}
                    {p.fbPostId && (
                      <span className="font-mono text-[10px] opacity-60">{p.fbPostId}</span>
                    )}
                    <span>
                      Comments: {p.comments.published}/{p.comments.total} published
                      {p.comments.missing > 0 && (
                        <span className="ml-1 font-medium text-red-600">
                          {p.comments.missing} missing
                        </span>
                      )}
                    </span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex shrink-0 items-center gap-1 sm:flex-col">
                  <button
                    onClick={() => toggleHistory(p.id)}
                    className="rounded-lg border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted"
                    title="Comment history"
                  >
                    {expandedPostId === p.id ? (
                      <ChevronUp className="mr-1 inline h-3.5 w-3.5" />
                    ) : (
                      <ChevronDown className="mr-1 inline h-3.5 w-3.5" />
                    )}
                    History
                  </button>
                  {p.status === "posted" && p.fbPostId && (
                    <button
                      onClick={() => deletePostFromFb(p.id)}
                      disabled={busyPostId === p.id}
                      className="rounded-lg border border-destructive/30 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                      title="Delete from Facebook"
                    >
                      <Trash2 className="mr-1 inline h-3.5 w-3.5" />
                      Delete
                    </button>
                  )}
                </div>
              </div>

              {/* Comment history (Feature 3) */}
              {expandedPostId === p.id && (
                <div className="border-t bg-muted/20 px-4 py-4">
                  {historyLoading ? (
                    <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" /> Loading comment history…
                    </p>
                  ) : history.length === 0 ? (
                    <p className="py-4 text-sm text-muted-foreground">
                      No comments were configured for this post.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {history.map((c) => (
                        <div
                          key={c.id}
                          className="rounded-lg border bg-card p-3"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <CommentStatusBadge status={c.status} />
                              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                                {c.source === "immediate"
                                  ? "immediate comment"
                                  : `+${c.delayMinutes} min delayed`}
                              </span>
                              <span className="text-[11px] text-muted-foreground">
                                by this app · attempt {c.attemptCount}
                                {c.postedAt
                                  ? ` · published ${formatDateTime(c.postedAt)}`
                                  : c.lastAttemptAt
                                    ? ` · last try ${formatDateTime(c.lastAttemptAt)}`
                                    : ""}
                              </span>
                            </div>
                            <div className="flex items-center gap-1">
                              {(c.status === "failed" ||
                                c.status === "needs_review" ||
                                c.status === "pending") && (
                                <button
                                  onClick={() =>
                                    setEditing(
                                      editing?.commentId === c.id
                                        ? null
                                        : { commentId: c.id, text: c.message }
                                    )
                                  }
                                  className="rounded-lg border p-1.5 text-muted-foreground hover:bg-muted"
                                  title="Edit comment text before retry"
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                              )}
                              {(c.status === "failed" ||
                                c.status === "needs_review") && (
                                <button
                                  onClick={() => retryComment(c.id)}
                                  disabled={busyCommentId === c.id}
                                  className="inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                                >
                                  {busyCommentId === c.id ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <RotateCcw className="h-3.5 w-3.5" />
                                  )}
                                  Retry
                                </button>
                              )}
                              {c.status === "needs_review" && (
                                <button
                                  onClick={() => markPublished(c.id)}
                                  disabled={busyCommentId === c.id}
                                  className="inline-flex items-center gap-1 rounded-lg border border-green-600/40 px-2.5 py-1.5 text-xs font-medium text-green-700 hover:bg-green-50 disabled:opacity-50"
                                  title="I verified on Facebook that this comment exists"
                                >
                                  <CheckCircle2 className="h-3.5 w-3.5" />
                                  Mark published
                                </button>
                              )}
                              {(c.status === "failed" ||
                                c.status === "needs_review" ||
                                c.status === "pending") && (
                                <button
                                  onClick={() => skipComment(c.id)}
                                  disabled={busyCommentId === c.id}
                                  className="rounded-lg border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
                                  title="Stop retrying this comment"
                                >
                                  Skip
                                </button>
                              )}
                            </div>
                          </div>

                          {editing?.commentId === c.id ? (
                            <div className="mt-2 space-y-2">
                              <textarea
                                value={editing.text}
                                onChange={(e) =>
                                  setEditing({ commentId: c.id, text: e.target.value })
                                }
                                rows={3}
                                maxLength={2000}
                                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              />
                              <div className="flex gap-2">
                                <button
                                  onClick={() => retryComment(c.id, editing.text)}
                                  disabled={busyCommentId === c.id || !editing.text.trim()}
                                  className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                                >
                                  {busyCommentId === c.id && (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
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
                            <p className="mt-1.5 whitespace-pre-wrap break-words text-sm">
                              {c.message}
                            </p>
                          )}

                          {c.errorMessage && (
                            <p className="mt-1.5 rounded bg-red-50 px-2 py-1 text-xs text-red-600">
                              {c.errorMessage}
                            </p>
                          )}
                          {c.fbCommentId && (
                            <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                              fbCommentId: {c.fbCommentId}
                            </p>
                          )}
                        </div>
                      ))}
                      <p className="pt-1 text-[11px] text-muted-foreground">{historyNote}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
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
