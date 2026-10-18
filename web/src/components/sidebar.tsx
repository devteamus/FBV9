"use client";
import Link from "next/link";
import {
  LayoutDashboard,
  Link2,
  List,
  LogOut,
  User,
  X,
  BarChart3,
  Image as ImageIcon,
  MessageSquareWarning,
} from "lucide-react";
import { api } from "@/lib/api";

const nav = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/analytics", label: "Daily Overview", icon: BarChart3 },
  { href: "/dashboard/posts", label: "Published Posts", icon: ImageIcon },
  { href: "/dashboard/comments", label: "Missing Comments", icon: MessageSquareWarning },
  { href: "/dashboard/accounts", label: "Accounts", icon: Link2 },
  { href: "/dashboard/jobs", label: "Jobs", icon: List },
];

export function Sidebar({
  user,
  activePath,
  open = false,
  onClose,
}: {
  user: any;
  activePath: string;
  open?: boolean;
  onClose?: () => void;
}) {
  const handleLogout = async () => {
    try { await api.logout(); } catch { /* ignore */ }
    window.location.href = "/";
  };

  return (
    <>
      {/* Mobile backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r bg-card transition-transform duration-200 ease-in-out md:static md:z-auto md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-16 items-center justify-between border-b px-6">
          <span className="text-lg font-semibold tracking-tight">FB Poster</span>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted md:hidden"
            aria-label="Close menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <nav className="flex-1 space-y-1 p-4">
          {nav.map((item) => {
            const active = activePath === item.href || activePath.startsWith(item.href + "/");
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t p-4">
          <div className="flex items-center gap-3 rounded-lg px-3 py-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
              <User className="h-4 w-4" />
            </div>
            <div className="flex-1 overflow-hidden">
              <p className="truncate text-sm font-medium">{user?.username}</p>
              <p className="truncate text-xs text-muted-foreground">{user?.email}</p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="mt-2 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
          <p className="mt-3 text-center text-[11px] text-muted-foreground">
            Dev:{" "}
            <a
              href="https://www.linkedin.com/in/ifaisalh/"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Md Faisal Hossain
            </a>
          </p>
        </div>
      </aside>
    </>
  );
}
