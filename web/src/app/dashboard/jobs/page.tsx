"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Upload, Pause, Play, Trash2, Eye, Loader2, Download } from "lucide-react";

interface Account {
  id: string;
  name: string;
}

interface Job {
  id: string;
  originalFilename: string;
  accountName: string | null;
  status: string;
  intervalMinutes: number;
  scheduledStartAt: string | null;
  totalPosts: number;
  completedPosts: number;
  failedPosts: number;
  createdAt: string;
}

interface ScheduledComment {
  id: string;
  message: string;
  delayMinutes: number;
  status: string;
  errorMessage: string | null;
}

interface Post {
  id: string;
  caption: string;
  mediaUrl: string;
  postType: string;
  comment: string | null;
  commentPosted: boolean;
  status: string;
  fbPostId: string | null;
  scheduledComments: ScheduledComment[];
}

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [uploading, setUploading] = useState(false);
  const [selectedPostIds, setSelectedPostIds] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [deletingPostId, setDeletingPostId] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [bulk, setBulk] = useState<{ action: "pause" | "resume"; done: number; total: number; failed: number } | null>(null);

  const load = () => {
    Promise.all([api.listJobs(), api.listAccounts()])
      .then(([j, a]) => { setJobs(j); setAccounts(a); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const handleUpload = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const formData = new FormData(form);
    // datetime-local → ISO pinned to Bangladesh time (BDT = UTC+6).
    // The picker value is "YYYY-MM-DDTHH:mm" (some browsers add ":ss");
    // normalize to the full ISO form the API expects.
    const startTime = (formData.get("start_time") as string | "").trim();
    if (startTime) {
      const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/.exec(startTime);
      if (m) formData.set("start_at", `${m[1]}:00+06:00`);
    } else {
      formData.delete("start_at");
    }
    setUploading(true);
    try {
      const res = await api.uploadCSV(formData);
      setShowUpload(false);
      form.reset(); // only clear the form after a successful upload
      load();
      if (res?.warnings?.length) alert(res.warnings.join("\n"));
    } catch (err: any) {
      // Keep the form + chosen file so the user can fix the sheet and retry
      alert(err.message);
    } finally {
      setUploading(false);
    }
  };

  const viewPosts = async (job: Job) => {
    setSelectedJob(job);
    setSelectedPostIds(new Set());
    const p = await api.getJobPosts(job.id);
    setPosts(p);
  };

  const refreshPosts = async () => {
    if (!selectedJob) return;
    // Reload everything loaded so far (at least the first page)
    const p = await api.getJobPosts(selectedJob.id, {
      limit: Math.min(2000, Math.max(1000, posts.length)),
    });
    setPosts(p);
  };

  const loadMorePosts = async () => {
    if (!selectedJob) return;
    setLoadingMore(true);
    try {
      const next = await api.getJobPosts(selectedJob.id, { limit: 1000, offset: posts.length });
      setPosts((prev) => [...prev, ...next]);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setLoadingMore(false);
    }
  };

  const deletablePostIds = posts.filter((p) => p.status === "posted" && p.fbPostId).map((p) => p.id);

  const toggleSelectPost = (id: string) => {
    setSelectedPostIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedPostIds((prev) =>
      prev.size === deletablePostIds.length ? new Set() : new Set(deletablePostIds)
    );
  };

  const deletePostFromFb = async (postId: string) => {
    if (!confirm("Delete this post from Facebook? This cannot be undone.")) return;
    setDeletingPostId(postId);
    try {
      await api.deletePostFromFacebook(postId);
      setPosts((prev) => prev.map((p) => (p.id === postId ? { ...p, status: "deleting" } : p)));
      setTimeout(refreshPosts, 4000);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setDeletingPostId(null);
    }
  };

  const bulkDeleteSelected = async () => {
    if (selectedPostIds.size === 0) return;
    if (!confirm(`Delete ${selectedPostIds.size} post(s) from Facebook? This cannot be undone.`)) return;
    setBulkDeleting(true);
    try {
      const result = await api.bulkDeletePosts(Array.from(selectedPostIds));
      setPosts((prev) =>
        prev.map((p) => (selectedPostIds.has(p.id) && !result.skipped.includes(p.id)
          ? { ...p, status: "deleting" }
          : p))
      );
      setSelectedPostIds(new Set());
      if (result.skipped.length > 0) {
        alert(`${result.queued} queued for deletion. ${result.skipped.length} were skipped (already deleted or not eligible).`);
      }
      setTimeout(refreshPosts, 4000);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setBulkDeleting(false);
    }
  };

  // ── One-click Pause all / Resume all ─────────────────────────
  // Pause: every running job + all pending comments stop.
  // Resume: every paused job continues on ITS OWN schedule —
  //   • a job whose next post is still in the future keeps that exact time
  //     (e.g. account 3's 2:00 PM start stays 2:00 PM)
  //   • jobs whose next post came due while paused restart in the same
  //     order and with the same gaps they originally had (the earliest one
  //     right now) — so accounts never all fire at the same moment
  //   • after the first post, every job continues at its own +interval
  // Runs the per-job endpoints 4 at a time with live progress.
  const runBulk = async (action: "pause" | "resume") => {
    if (bulk) return;
    let fresh: Job[];
    try {
      fresh = await api.listJobs(); // fresh list — the table may be stale
    } catch (err: any) {
      alert(err.message);
      return;
    }
    const wanted = action === "pause" ? "running" : "paused";
    const targets = fresh.filter((j) => j.status === wanted);
    if (targets.length === 0) {
      alert(action === "pause" ? "No running jobs to pause." : "No paused jobs to resume.");
      return;
    }
    const msg =
      action === "pause"
        ? `Pause ${targets.length} running job(s) and all pending comments? Nothing more will be posted or commented until you resume.`
        : `Resume ${targets.length} paused job(s) and their comments? Each account continues on its own schedule.`;
    if (!confirm(msg)) return;

    // Resume: work out each job's start time (keeps the original stagger)
    const startFor = new Map<string, string>();
    if (action === "resume") {
      try {
        const plan = await api.getResumePlan();
        const now = Date.now();
        const due = new Map(plan.map((p) => [p.jobId, new Date(p.nextDue).getTime()]));
        const overdue = targets.map((j) => due.get(j.id)).filter((t): t is number => t !== undefined && t < now);
        const earliest = overdue.length ? Math.min(...overdue) : 0;
        for (const j of targets) {
          const t = due.get(j.id);
          if (t === undefined) continue;
          startFor.set(j.id, new Date(t < now ? now + (t - earliest) : t).toISOString());
        }
        // start the earliest ones first
        targets.sort((a, b) => (startFor.get(a.id) ?? "").localeCompare(startFor.get(b.id) ?? ""));
      } catch {
        // plan unavailable — fall back to the per-job rule (still safe)
      }
    }

    let next = 0;
    let done = 0;
    let failed = 0;
    const errors: string[] = [];
    setBulk({ action, done: 0, total: targets.length, failed: 0 });

    const worker = async () => {
      while (next < targets.length) {
        const job = targets[next++];
        try {
          if (action === "pause") await api.pauseJob(job.id);
          else await api.resumeJob(job.id, startFor.get(job.id));
        } catch (err: any) {
          failed++;
          if (errors.length < 5) errors.push(`${job.accountName}: ${err.message}`);
        }
        done++;
        setBulk({ action, done, total: targets.length, failed });
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));

    // Comments of already-finished jobs (their delayed comments are still
    // queued) — pause / resume them too.
    try {
      if (action === "pause") await api.pauseAllComments();
      else await api.resumeAllComments();
    } catch (err: any) {
      errors.push(`comments: ${err.message}`);
      failed++;
    }

    setBulk(null);
    load();
    if (failed > 0) {
      alert(`Finished with ${failed} problem(s). Click again to retry the rest.\n${errors.join("\n")}`);
    }
  };

  const runningCount = jobs.filter((j) => j.status === "running").length;
  const pausedCount = jobs.filter((j) => j.status === "paused").length;

  const toggleJob = async (job: Job) => {
    if (job.status === "running") await api.pauseJob(job.id);
    else if (job.status === "paused") await api.resumeJob(job.id);
    load();
  };

  const deleteJob = async (id: string) => {
    if (!confirm("Delete this job and all its posts?")) return;
    await api.deleteJob(id);
    load();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
          <p className="text-sm text-muted-foreground">Manage your bulk posting campaigns</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button onClick={() => runBulk("pause")} disabled={!!bulk || runningCount === 0}
            className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50">
            {bulk?.action === "pause" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pause className="h-4 w-4" />}
            {bulk?.action === "pause" ? `Pausing ${bulk.done}/${bulk.total}` : `Pause all (${runningCount})`}
          </button>
          <button onClick={() => runBulk("resume")} disabled={!!bulk || pausedCount === 0}
            className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50">
            {bulk?.action === "resume" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {bulk?.action === "resume" ? `Resuming ${bulk.done}/${bulk.total}` : `Resume all (${pausedCount})`}
          </button>
          <button onClick={() => setShowUpload(!showUpload)}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            <Upload className="h-4 w-4" />
            Upload CSV
          </button>
        </div>
      </div>

      {showUpload && (
        <form onSubmit={handleUpload} encType="multipart/form-data" className="rounded-xl border bg-card p-6 shadow-sm space-y-4">
          <h3 className="text-sm font-semibold">New bulk post job</h3>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Account</label>
              <select name="account_id" required className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <option value="">Select page</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Interval value</label>
              <input name="interval_value" type="number" min={1} defaultValue={2} required
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Unit</label>
              <select name="interval_unit" defaultValue="hours" className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <option value="minutes">Minutes</option>
                <option value="hours">Hours</option>
                <option value="days">Days</option>
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Start time (optional)</label>
              <input name="start_time" type="datetime-local"
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
              <p className="text-xs text-muted-foreground">Bangladesh time (GMT+6). First post fires at this time, then every interval. Leave empty to start immediately.</p>
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">CSV or Excel file</label>
            <input name="csv" type="file" accept=".csv,.xlsx" required
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm file:mr-4 file:rounded file:border-0 file:bg-primary file:px-2 file:py-1 file:text-xs file:text-primary-foreground" />
            <div className="flex flex-wrap items-center gap-2">
              <a href="/api/upload/template?format=csv" download
                className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-muted">
                <Download className="h-3.5 w-3.5" /> Demo CSV
              </a>
              <a href="/api/upload/template?format=xlsx" download
                className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-muted">
                <Download className="h-3.5 w-3.5" /> Demo Excel (.xlsx)
              </a>
              <span className="text-xs text-muted-foreground">Google Sheets: File → Download → CSV or Excel (.xlsx), then upload.</span>
            </div>
            <p className="text-xs text-muted-foreground">Columns: caption (required), media_url (required for image/video/reel), post_type (text/image/video/reel — default image), comment_1 + comment_1_delay_minutes (blank/0 = right after the post), comment_2 + comment_2_delay_minutes (minutes after the post, 1 or more). Leave any comment blank to skip it.</p>
          </div>
          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={uploading} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Start job"}
            </button>
            <button type="button" onClick={() => setShowUpload(false)} className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-muted">Cancel</button>
          </div>
        </form>
      )}

      <div className="rounded-xl border bg-card shadow-sm overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-6 py-3 text-left font-medium text-muted-foreground">File</th>
              <th className="px-6 py-3 text-left font-medium text-muted-foreground">Account</th>
              <th className="px-6 py-3 text-left font-medium text-muted-foreground">Progress</th>
              <th className="px-6 py-3 text-left font-medium text-muted-foreground">Status</th>
              <th className="px-6 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr><td colSpan={5} className="px-6 py-8 text-center text-muted-foreground">Loading...</td></tr>
            ) : jobs.length === 0 ? (
              <tr><td colSpan={5} className="px-6 py-8 text-center text-muted-foreground">No jobs yet.</td></tr>
            ) : (
              jobs.map((job) => (
                <tr key={job.id} className="hover:bg-muted/30">
                  <td className="px-6 py-4">
                    <p className="font-medium">{job.originalFilename}</p>
                    <p className="text-xs text-muted-foreground">{new Date(job.createdAt).toLocaleString()}</p>
                    {job.scheduledStartAt && new Date(job.scheduledStartAt) > new Date() && (
                      <p className="text-xs text-blue-600">
                        Starts: {new Date(job.scheduledStartAt).toLocaleString("en-GB", { timeZone: "Asia/Dhaka" })} (BDT)
                      </p>
                    )}
                  </td>
                  <td className="px-6 py-4 text-muted-foreground">{job.accountName}</td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className="h-2 w-24 overflow-hidden rounded-full bg-muted">
                        <div className="h-full bg-green-500 transition-all" style={{ width: `${job.totalPosts ? (job.completedPosts / job.totalPosts) * 100 : 0}%` }} />
                      </div>
                      <span className="text-xs text-muted-foreground">{job.completedPosts}/{job.totalPosts}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4"><StatusBadge status={job.status} /></td>
                  <td className="px-6 py-4">
                    <div className="flex justify-end gap-1">
                      <button onClick={() => viewPosts(job)} className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground" title="View posts"><Eye className="h-4 w-4" /></button>
                      {(job.status === "running" || job.status === "paused") && (
                        <button onClick={() => toggleJob(job)} className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground" title={job.status === "running" ? "Pause" : "Resume"}>
                          {job.status === "running" ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                        </button>
                      )}
                      <button onClick={() => deleteJob(job.id)} className="rounded-lg p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" title="Delete"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {selectedJob && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-2xl max-h-[80vh] overflow-y-auto rounded-xl border bg-card p-6 shadow-lg">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Posts: {selectedJob.originalFilename}</h3>
              <button onClick={() => { setSelectedJob(null); setPosts([]); setSelectedPostIds(new Set()); }} className="rounded-lg p-2 hover:bg-muted">✕</button>
            </div>

            {deletablePostIds.length > 0 && (
              <div className="mb-3 flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2">
                <label className="flex items-center gap-2 text-xs font-medium">
                  <input
                    type="checkbox"
                    checked={selectedPostIds.size > 0 && selectedPostIds.size === deletablePostIds.length}
                    onChange={toggleSelectAll}
                  />
                  Select all deletable ({deletablePostIds.length})
                </label>
                <button
                  onClick={bulkDeleteSelected}
                  disabled={selectedPostIds.size === 0 || bulkDeleting}
                  className="inline-flex items-center gap-1 rounded-lg bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
                >
                  {bulkDeleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  Delete selected ({selectedPostIds.size})
                </button>
              </div>
            )}

            <div className="space-y-2">
              {posts.map((p) => (
                <div key={p.id} className="flex items-center justify-between rounded-lg border p-3">
                  <div className="flex min-w-0 items-start gap-3">
                    {p.status === "posted" && p.fbPostId && (
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={selectedPostIds.has(p.id)}
                        onChange={() => toggleSelectPost(p.id)}
                      />
                    )}
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{p.caption}</p>
                      <p className="truncate text-xs text-muted-foreground">{p.mediaUrl}</p>
                      {p.comment && (
                        <p className="mt-1 truncate text-xs">
                          <span className="text-muted-foreground">Comment: </span>
                          <span className={p.commentPosted ? "text-green-600" : p.status === "posted" ? "text-red-600" : "text-muted-foreground"}>
                            {p.comment}
                            {p.status === "posted" && (p.commentPosted ? " ✓" : " (failed to post)")}
                          </span>
                        </p>
                      )}
                      {p.scheduledComments?.map((sc) => (
                        <p key={sc.id} className="mt-0.5 truncate text-xs">
                          <span className="text-muted-foreground">+{sc.delayMinutes}min comment: </span>
                          <span className={
                            sc.status === "published" ? "text-green-600" :
                            sc.status === "failed" || sc.status === "needs_review" ? "text-red-600" :
                            sc.status === "skipped" ? "text-gray-400" :
                            "text-muted-foreground"
                          }>
                            {sc.message} ({sc.status})
                          </span>
                        </p>
                      ))}
                    </div>
                  </div>
                  <div className="ml-4 flex shrink-0 items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      p.status === "posted" ? "bg-green-100 text-green-700" :
                      p.status === "failed" ? "bg-red-100 text-red-700" :
                      p.status === "scheduled" ? "bg-blue-100 text-blue-700" :
                      p.status === "paused" ? "bg-gray-100 text-gray-700" :
                      p.status === "deleting" ? "bg-orange-100 text-orange-700" :
                      p.status === "deleted" ? "bg-gray-200 text-gray-500" :
                      "bg-yellow-100 text-yellow-700"
                    }`}>{p.status}</span>
                    {p.status === "posted" && p.fbPostId && (
                      <button
                        onClick={() => deletePostFromFb(p.id)}
                        disabled={deletingPostId === p.id}
                        className="rounded-lg p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                        title="Delete from Facebook"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {selectedJob.totalPosts > posts.length && (
              <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
                <span>Showing {posts.length} of {selectedJob.totalPosts} posts</span>
                <button onClick={loadMorePosts} disabled={loadingMore}
                  className="rounded-lg border px-3 py-1.5 font-medium hover:bg-muted disabled:opacity-50">
                  {loadingMore ? "Loading..." : "Load more"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: "bg-yellow-100 text-yellow-700",
    running: "bg-blue-100 text-blue-700",
    paused: "bg-gray-100 text-gray-700",
    completed: "bg-green-100 text-green-700",
    failed: "bg-red-100 text-red-700",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${map[status] || map.pending}`}>
      {status}
    </span>
  );
}
