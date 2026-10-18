"use client";
/**
 * Shared UI primitives for the v2.1 dashboard pages — status badges,
 * the date-range picker (today / yesterday / last 7 days / custom),
 * simple pagination, and a page-avatar with graceful fallback.
 * Styling follows the existing dashboard conventions (rounded-xl cards,
 * muted foreground, tailwind color badges).
 */

import { useState } from "react";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";

// ── Status badges ────────────────────────────────────────────

const POST_STATUS_STYLES: Record<string, string> = {
  posted: "bg-green-100 text-green-700",
  scheduled: "bg-blue-100 text-blue-700",
  pending: "bg-yellow-100 text-yellow-700",
  posting: "bg-indigo-100 text-indigo-700",
  failed: "bg-red-100 text-red-700",
  deleted: "bg-gray-200 text-gray-500",
  deleting: "bg-orange-100 text-orange-700",
};

export function PostStatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
        POST_STATUS_STYLES[status] ?? POST_STATUS_STYLES.pending
      }`}
    >
      {status}
    </span>
  );
}

const COMMENT_STATUS_STYLES: Record<string, string> = {
  published: "bg-green-100 text-green-700",
  pending: "bg-blue-100 text-blue-700",
  processing: "bg-indigo-100 text-indigo-700",
  failed: "bg-red-100 text-red-700",
  needs_review: "bg-amber-100 text-amber-700",
  skipped: "bg-gray-200 text-gray-600",
  missing: "bg-red-100 text-red-700",
  none: "bg-gray-100 text-gray-500",
  partial: "bg-purple-100 text-purple-700",
};

const COMMENT_STATUS_LABELS: Record<string, string> = {
  needs_review: "needs review",
};

export function CommentStatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
        COMMENT_STATUS_STYLES[status] ?? "bg-gray-100 text-gray-500"
      }`}
    >
      {COMMENT_STATUS_LABELS[status] ?? status}
    </span>
  );
}

// ── Page avatar with fallback ─────────────────────────────────

export function PageAvatar({
  name,
  pictureUrl,
  size = 36,
}: {
  name: string;
  pictureUrl?: string | null;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const letter = (name || "?").trim().charAt(0).toUpperCase();

  if (!pictureUrl || failed) {
    return (
      <div
        className="flex shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary"
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        {letter}
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={pictureUrl}
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded-full object-cover"
      style={{ width: size, height: size }}
      onError={() => setFailed(true)}
      referrerPolicy="no-referrer"
    />
  );
}

// ── Date-range picker ─────────────────────────────────────────

export interface RangeSelection {
  preset: "today" | "yesterday" | "last7" | "custom" | "all";
  from?: string; // YYYY-MM-DD
  to?: string; // YYYY-MM-DD
}

const RANGE_PRESETS: Array<{ value: RangeSelection["preset"]; label: string }> = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last7", label: "Last 7 days" },
  { value: "custom", label: "Custom" },
];

export function DateRangePicker({
  value,
  onChange,
  allowAll = true,
}: {
  value: RangeSelection;
  onChange: (v: RangeSelection) => void;
  allowAll?: boolean;
}) {
  const options = allowAll
    ? [...RANGE_PRESETS, { value: "all" as const, label: "All time" }]
    : RANGE_PRESETS;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap gap-1 rounded-lg border bg-background p-1">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange({ preset: o.value })}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              value.preset === o.value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
      {value.preset === "custom" && (
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={value.from ?? ""}
            max={value.to}
            onChange={(e) => onChange({ ...value, from: e.target.value })}
            className="rounded-lg border border-input bg-background px-3 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="From date"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <input
            type="date"
            value={value.to ?? ""}
            min={value.from}
            onChange={(e) => onChange({ ...value, to: e.target.value })}
            className="rounded-lg border border-input bg-background px-3 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="To date"
          />
        </div>
      )}
    </div>
  );
}

/** Convert a RangeSelection into API query params (empty when invalid). */
export function rangeToQuery(r: RangeSelection): {
  preset?: string;
  from?: string;
  to?: string;
} {
  if (r.preset === "custom") {
    if (!r.from || !r.to) return {}; // incomplete custom range → query all
    return { preset: "custom", from: r.from, to: r.to };
  }
  return { preset: r.preset };
}

// ── Pagination ─────────────────────────────────────────────────

export function Pagination({
  page,
  totalPages,
  total,
  onPage,
}: {
  page: number;
  totalPages: number;
  total: number;
  onPage: (p: number) => void;
}) {
  if (totalPages <= 1) {
    return (
      <p className="px-1 text-xs text-muted-foreground">
        {total} item{total === 1 ? "" : "s"}
      </p>
    );
  }
  return (
    <div className="flex items-center gap-3">
      <p className="text-xs text-muted-foreground">
        {total} item{total === 1 ? "" : "s"} · page {page} / {totalPages}
      </p>
      <div className="flex gap-1">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          className="rounded-lg border p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-40"
          aria-label="Previous page"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => onPage(page + 1)}
          className="rounded-lg border p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-40"
          aria-label="Next page"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// ── Loading / empty / error states ─────────────────────────────

export function LoadingRow({ colSpan, label = "Loading…" }: { colSpan: number; label?: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-6 py-10 text-center text-sm text-muted-foreground">
        <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
        {label}
      </td>
    </tr>
  );
}

export function EmptyRow({ colSpan, label }: { colSpan: number; label: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-6 py-10 text-center text-sm text-muted-foreground">
        {label}
      </td>
    </tr>
  );
}

// ── Media preview ──────────────────────────────────────────────

export function MediaPreview({
  mediaUrl,
  postType,
  className = "h-20 w-20",
}: {
  mediaUrl: string;
  postType: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (!mediaUrl || postType === "text" || failed) {
    return (
      <div
        className={`flex items-center justify-center rounded-lg border bg-muted/50 text-[10px] font-medium uppercase tracking-wide text-muted-foreground ${className}`}
      >
        {postType === "text" || !mediaUrl ? "text" : "media"}
      </div>
    );
  }

  if (postType === "video" || postType === "reel") {
    return (
      <video
        src={mediaUrl}
        muted
        playsInline
        preload="metadata"
        className={`rounded-lg border bg-muted/50 object-cover ${className}`}
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={mediaUrl}
      alt=""
      className={`rounded-lg border bg-muted/50 object-cover ${className}`}
      onError={() => setFailed(true)}
      loading="lazy"
      referrerPolicy="no-referrer"
    />
  );
}

// ── Formatting helpers ─────────────────────────────────────────

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const future = diff < 0;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60_000);
  const hours = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);
  let text: string;
  if (mins < 1) text = "just now";
  else if (mins < 60) text = `${mins} min`;
  else if (hours < 24) text = `${hours} h`;
  else text = `${days} d`;
  if (text === "just now") return text;
  return future ? `in ${text}` : `${text} ago`;
}
