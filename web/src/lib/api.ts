/**
 * API client for FB Auto-Poster v2.
 *
 * v2 uses httpOnly cookies for auth — NO localStorage, NO Authorization header.
 * Cookies are sent automatically by the browser.
 * On 401 response, redirect to /.
 */

async function fetcher<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const isFormData = options.body instanceof FormData;
  const res = await fetch(path, {
    ...options,
    headers: {
      // Don't set Content-Type for FormData — browser sets multipart/form-data
      // with the correct boundary automatically.
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      ...options.headers,
    },
  });

  // On 401, redirect to login (cookie expired or invalid)
  if (res.status === 401) {
    if (typeof window !== "undefined") {
      window.location.href = "/";
    }
    throw new Error("Not authenticated");
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

export const api = {
  register: (body: { username: string; email: string; password: string }) =>
    fetcher("/api/auth/register", { method: "POST", body: JSON.stringify(body) }),

  login: (body: { email: string; password: string }) =>
    fetcher("/api/auth/login", { method: "POST", body: JSON.stringify(body) }),

  forgotPassword: (body: { email: string }) =>
    fetcher<{ success: boolean; message: string; expiresInMinutes: number }>(
      "/api/auth/forgot-password",
      { method: "POST", body: JSON.stringify(body) }
    ),

  resetPassword: (body: { email: string; code: string; newPassword: string }) =>
    fetcher<{ success: boolean; message: string }>(
      "/api/auth/reset-password",
      { method: "POST", body: JSON.stringify(body) }
    ),

  logout: () =>
    fetcher("/api/auth/logout", { method: "POST" }),

  me: () => fetcher<{ id: string; username: string; email: string; isActive: boolean; createdAt: string; accountCount: number }>("/api/auth/me"),

  listAccounts: () =>
    fetcher<Array<{
      id: string;
      name: string;
      fbPageId: string;
      fbApiVersion: string;
      isActive: boolean;
      createdAt: string;
      jobCount: number;
    }>>("/api/accounts"),

  createAccount: (body: {
    name: string;
    fb_page_access_token: string;
    fb_page_id: string;
    fb_api_version?: string;
  }) =>
    fetcher("/api/accounts", { method: "POST", body: JSON.stringify(body) }),

  // v2.2: bulk connect accounts from a CSV (Account name, Page ID,
  // Page Access Token columns).
  bulkImportAccounts: (formData: FormData) =>
    fetcher<{
      success: boolean;
      created: number;
      skippedDuplicates: number;
      skippedAlreadyConnected: number;
      message: string;
    }>("/api/accounts/bulk-csv", { method: "POST", body: formData }),

  deleteAccount: (id: string) =>
    fetcher(`/api/accounts/${id}`, { method: "DELETE" }),

  validateAccount: (id: string) =>
    fetcher<{ success: boolean; page?: { id: string; name: string }; error?: string }>(
      `/api/accounts/${id}/validate`,
      { method: "POST" }
    ),

  listJobs: (accountId?: string) =>
    fetcher<Array<{
      id: string;
      accountId: string;
      accountName: string | null;
      originalFilename: string;
      status: string;
      intervalMinutes: number;
      scheduledStartAt: string | null;
      totalPosts: number;
      completedPosts: number;
      failedPosts: number;
      createdAt: string;
      startedAt: string | null;
      completedAt: string | null;
      csvDeleted: boolean;
      errorMessage: string | null;
    }>>(`/api/jobs${accountId ? `?account_id=${accountId}` : ""}`),

  getJob: (id: string) => fetcher(`/api/jobs/${id}`),

  getJobPosts: (id: string, opts: { limit?: number; offset?: number } = {}) =>
    fetcher<Array<{
      id: string;
      jobId: string;
      accountId: string;
      caption: string;
      fullCaption: string;
      mediaUrl: string;
      postType: string;
      comment: string | null;
      commentPosted: boolean;
      commentError: string | null;
      status: string;
      scheduledAt: string | null;
      postedAt: string | null;
      fbPostId: string | null;
      errorMessage: string | null;
      retryCount: number;
      scheduledComments: Array<{
        id: string;
        message: string;
        delayMinutes: number;
        status: string;
        errorMessage: string | null;
      }>;
    }>>(
      `/api/jobs/${id}/posts?limit=${opts.limit ?? 1000}&offset=${opts.offset ?? 0}`
    ),

  deletePostFromFacebook: (postId: string) =>
    fetcher<{ success: boolean; queued: boolean }>(
      `/api/posts/${postId}/delete-from-facebook`,
      { method: "POST" }
    ),

  bulkDeletePosts: (postIds: string[]) =>
    fetcher<{ success: boolean; queued: number; skipped: string[] }>(
      "/api/posts/bulk-delete",
      { method: "POST", body: JSON.stringify({ post_ids: postIds }) }
    ),

  pauseJob: (id: string) =>
    fetcher(`/api/jobs/${id}/pause`, { method: "POST" }),

  resumeJob: (id: string, startAt?: string) =>
    fetcher(`/api/jobs/${id}/resume`, {
      method: "POST",
      ...(startAt ? { body: JSON.stringify({ start_at: startAt }) } : {}),
    }),

  getResumePlan: () =>
    fetcher<Array<{ jobId: string; nextDue: string }>>("/api/jobs/resume-plan"),

  pauseAllComments: () =>
    fetcher<{ success: boolean; paused: number }>("/api/comments/pause-all", { method: "POST" }),

  resumeAllComments: () =>
    fetcher<{ success: boolean; resumed: number }>("/api/comments/resume-all", { method: "POST" }),

  deleteJob: (id: string) =>
    fetcher(`/api/jobs/${id}`, { method: "DELETE" }),

  uploadCSV: (formData: FormData) =>
    fetcher<{
      success: boolean;
      format: "csv" | "xlsx";
      rows: number;
      warnings: string[];
    }>("/api/upload", { method: "POST", body: formData, headers: {} }),

  stats: () =>
    fetcher<{
      total_jobs: number;
      total_posts: number;
      posted: number;
      pending: number;
      failed: number;
      account_count: number;
    }>("/api/stats"),

  // ── v2.1: Analytics (Features 1 & 6) ─────────────────────
  analytics: (query: {
    preset?: string;
    from?: string;
    to?: string;
    account_id?: string;
  }) =>
    fetcher<{
      range: { from: string; to: string; preset: string };
      accounts: Array<{
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
      }>;
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
    }>(`/api/analytics?${new URLSearchParams(
      Object.entries(query).filter(([, v]) => v !== undefined && v !== "") as [string, string][]
    ).toString()}`),

  // ── v2.1: Published posts preview (Feature 2) ──────────
  listPublishedPosts: (query: {
    account_id?: string;
    post_type?: string;
    status?: string;
    comment_status?: string;
    preset?: string;
    from?: string;
    to?: string;
    page?: number;
    page_size?: number;
  }) =>
    fetcher<{
      posts: Array<{
        id: string;
        jobId: string;
        accountId: string;
        accountName: string | null;
        accountPictureUrl: string | null;
        pageId: string | null;
        caption: string;
        mediaUrl: string;
        postType: string;
        comment: string | null;
        status: string;
        scheduledAt: string | null;
        postedAt: string | null;
        fbPostId: string | null;
        fbLink: string | null;
        errorMessage: string | null;
        retryCount: number;
        comments: { published: number; pending: number; missing: number; total: number };
        commentStatus: "none" | "published" | "partial" | "pending" | "missing";
      }>;
      pagination: { page: number; pageSize: number; total: number; totalPages: number };
    }>(`/api/posts?${new URLSearchParams(
      Object.entries(query).filter(([, v]) => v !== undefined && v !== "") as [string, string][]
    ).toString()}`),

  // ── v2.1: Post comment history (Feature 3) ────────────
  getPostComments: (postId: string) =>
    fetcher<{
      postId: string;
      note: string;
      comments: Array<{
        id: string;
        postId: string;
        message: string;
        delayMinutes: number;
        source: string;
        accountId: string | null;
        fbPostId: string | null;
        status: string;
        fbCommentId: string | null;
        errorMessage: string | null;
        attemptCount: number;
        lastAttemptAt: string | null;
        postedAt: string | null;
        createdAt: string;
        isAutomation: boolean;
      }>;
    }>(`/api/posts/${postId}/comments`),

  // ── v2.1: Missing comments (Feature 4) ──────────────
  listMissingComments: (query: {
    account_ids?: string;
    status?: string;
    preset?: string;
    from?: string;
    to?: string;
    page?: number;
    page_size?: number;
  }) =>
    fetcher<{
      items: Array<{
        commentId: string | null;
        postId: string;
        accountId: string;
        accountName: string;
        pageId: string;
        commentText: string;
        status: string;
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
      }>;
      pagination: { page: number; pageSize: number; total: number; totalPages: number };
    }>(`/api/comments/missing?${new URLSearchParams(
      Object.entries(query).filter(([, v]) => v !== undefined && v !== "") as [string, string][]
    ).toString()}`),

  publishPostComment: (postId: string, message?: string) =>
    fetcher<{ success: boolean; commentId: string; queued: boolean; attempt: number }>(
      `/api/posts/${postId}/publish-comment`,
      { method: "POST", body: JSON.stringify({ message }) }
    ),

  publishComment: (commentId: string, message?: string) =>
    fetcher<{ success: boolean; commentId: string; queued: boolean; attempt: number }>(
      `/api/comments/${commentId}/publish`,
      { method: "POST", body: JSON.stringify({ message }) }
    ),

  markCommentPublished: (commentId: string, fbCommentId?: string) =>
    fetcher<{ success: boolean; commentId: string }>(
      `/api/comments/${commentId}/mark-published`,
      { method: "POST", body: JSON.stringify({ fbCommentId }) }
    ),

  skipComment: (commentId: string) =>
    fetcher<{ success: boolean; commentId: string }>(
      `/api/comments/${commentId}/skip`,
      { method: "POST" }
    ),

  bulkRetryComments: (postIds: string[]) =>
    fetcher<{
      success: boolean;
      totalQueued: number;
      totalSkipped: number;
      results: Array<{
        postId: string;
        queued: number;
        skipped: number;
        details: Array<{
          commentId: string | null;
          text: string;
          status: "queued" | "skipped";
          reason?: string;
        }>;
      }>;
      errors: string[];
    }>("/api/comments/bulk-retry", {
      method: "POST",
      body: JSON.stringify({ post_ids: postIds }),
    }),

  health: () => fetcher("/api/health"),
};
