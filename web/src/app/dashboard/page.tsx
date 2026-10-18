"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Activity, CheckCircle, Clock, AlertCircle, Users } from "lucide-react";

interface Stats {
  total_jobs: number;
  total_posts: number;
  posted: number;
  pending: number;
  failed: number;
  account_count: number;
}

interface Job {
  id: string;
  originalFilename: string;
  accountName: string | null;
  status: string;
  intervalMinutes: number;
  totalPosts: number;
  completedPosts: number;
  createdAt: string;
}

export default function OverviewPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.stats(), api.listJobs()])
      .then(([s, j]) => { setStats(s); setJobs(j.slice(0, 5)); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const cards = [
    { label: "Total jobs", value: stats?.total_jobs ?? 0, icon: Activity, color: "text-foreground" },
    { label: "Total posts", value: stats?.total_posts ?? 0, icon: Clock, color: "text-blue-500" },
    { label: "Posted", value: stats?.posted ?? 0, icon: CheckCircle, color: "text-green-500" },
    { label: "Failed", value: stats?.failed ?? 0, icon: AlertCircle, color: "text-red-500" },
    { label: "Accounts", value: stats?.account_count ?? 0, icon: Users, color: "text-purple-500" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Overview of your posting activity</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {cards.map((c) => (
          <div key={c.label} className="rounded-xl border bg-card p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">{c.label}</p>
              <c.icon className={`h-4 w-4 ${c.color}`} />
            </div>
            <p className="mt-2 text-3xl font-semibold tabular-nums">{c.value}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl border bg-card shadow-sm">
        <div className="border-b px-6 py-4">
          <h2 className="text-sm font-semibold">Recent jobs</h2>
        </div>
        <div className="divide-y">
          {loading ? (
            <div className="px-6 py-8 text-center text-sm text-muted-foreground">Loading...</div>
          ) : jobs.length === 0 ? (
            <div className="px-6 py-8 text-center text-sm text-muted-foreground">No jobs yet. Upload a CSV to get started.</div>
          ) : (
            jobs.map((job) => (
              <div key={job.id} className="flex items-center justify-between px-6 py-4">
                <div>
                  <p className="text-sm font-medium">{job.originalFilename}</p>
                  <p className="text-xs text-muted-foreground">
                    {job.accountName} · {job.completedPosts}/{job.totalPosts} posts · interval {job.intervalMinutes}m
                  </p>
                </div>
                <StatusBadge status={job.status} />
              </div>
            ))
          )}
        </div>
      </div>
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
