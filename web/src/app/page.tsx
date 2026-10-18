"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { Share2, Loader2 } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      if (mode === "login") {
        await api.login({ email, password });
      } else {
        await api.register({ username, email, password });
      }
      // Cookie is set by the server, redirect to dashboard
      router.push("/dashboard");
    } catch (err: any) {
      setError(err.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center space-y-2">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Share2 className="h-6 w-6" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">FB Auto-Poster</h1>
          <p className="text-sm text-muted-foreground">
            {mode === "login" ? "Sign in to your dashboard" : "Create a new account"}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="space-y-2">
            <label className="text-sm font-medium">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="you@example.com"
            />
          </div>

          {mode === "register" && (
            <div className="space-y-2">
              <label className="text-sm font-medium">Username</label>
              <input
                type="text"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="your_username"
              />
              <p className="text-xs text-muted-foreground">
                3-30 chars: letters, numbers, . _ -
              </p>
            </div>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Password</label>
              {mode === "login" && (
                <Link
                  href="/forgot-password"
                  className="text-xs font-medium text-primary underline underline-offset-4 hover:opacity-80"
                >
                  Forgot password?
                </Link>
              )}
            </div>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="••••••••"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="inline-flex w-full items-center justify-center rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          {mode === "login" ? (
            <>
              No account?{" "}
              <button onClick={() => setMode("register")} className="font-medium text-primary underline underline-offset-4">
                Register
              </button>
            </>
          ) : (
            <>
              Already have one?{" "}
              <button onClick={() => setMode("login")} className="font-medium text-primary underline underline-offset-4">
                Sign in
              </button>
            </>
          )}
        </p>

        <footer className="space-y-2 pt-4 text-center text-xs text-muted-foreground">
          <p className="space-x-3">
            <Link href="/privacy-policy" className="underline underline-offset-2 hover:text-foreground">
              Privacy Policy
            </Link>
            <span>·</span>
            <Link href="/terms" className="underline underline-offset-2 hover:text-foreground">
              Terms of Service
            </Link>
          </p>
          <p>
            Developed by{" "}
            <a
              href="https://www.linkedin.com/in/ifaisalh/"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium underline underline-offset-2 hover:text-foreground"
            >
              Md Faisal Hossain
            </a>
          </p>
        </footer>
      </div>
    </div>
  );
}
