"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { Share2, Loader2, ArrowLeft, Mail, KeyRound, CheckCircle2 } from "lucide-react";

type Step = "request" | "reset" | "done";

export default function ForgotPasswordPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("request");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [loading, setLoading] = useState(false);

  // Step 1: request code
  const handleRequestCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setInfo("");
    setLoading(true);
    try {
      const res = await api.forgotPassword({ email });
      setInfo(res.message || "If the email exists, a code has been sent.");
      setStep("reset");
    } catch (err: any) {
      setError(err.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  // Step 2: reset password
  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters long.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    try {
      const res = await api.resetPassword({
        email,
        code,
        newPassword,
      });
      setInfo(res.message || "Password reset successful.");
      setStep("done");
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
          <h1 className="text-2xl font-semibold tracking-tight">Reset password</h1>
          <p className="text-center text-sm text-muted-foreground">
            {step === "request" && "Enter your account email to receive a reset code."}
            {step === "reset" && "Enter the 6-digit code from your email and a new password."}
            {step === "done" && "Your password has been updated."}
          </p>
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}
        {info && step !== "done" && (
          <div className="rounded-lg border border-primary/40 bg-primary/5 px-4 py-3 text-sm text-primary">
            {info}
          </div>
        )}

        {/* STEP 1: Request code */}
        {step === "request" && (
          <form onSubmit={handleRequestCode} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Email</label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-lg border border-input bg-background py-2 pl-9 pr-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                  placeholder="you@example.com"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="inline-flex w-full items-center justify-center rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Send reset code
            </button>

            <button
              type="button"
              onClick={() => router.push("/")}
              className="inline-flex w-full items-center justify-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to login
            </button>
          </form>
        )}

        {/* STEP 2: Enter code + new password */}
        {step === "reset" && (
          <form onSubmit={handleResetPassword} className="space-y-4">
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

            <div className="space-y-2">
              <label className="text-sm font-medium">Reset code</label>
              <div className="relative">
                <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  className="w-full rounded-lg border border-input bg-background py-2 pl-9 pr-3 text-sm tracking-[0.5em] outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                  placeholder="000000"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Check your inbox (and spam folder). Code expires in 10 minutes.
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">New password</label>
              <input
                type="password"
                required
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="••••••••"
              />
              <p className="text-xs text-muted-foreground">Minimum 8 characters.</p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Confirm new password</label>
              <input
                type="password"
                required
                minLength={8}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
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
              Reset password
            </button>

            <button
              type="button"
              onClick={() => {
                setStep("request");
                setCode("");
                setNewPassword("");
                setConfirmPassword("");
                setError("");
              }}
              className="inline-flex w-full items-center justify-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              Use a different email
            </button>
          </form>
        )}

        {/* STEP 3: Success */}
        {step === "done" && (
          <div className="space-y-4 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
              <CheckCircle2 className="h-7 w-7" />
            </div>
            <p className="text-sm text-muted-foreground">{info}</p>
            <button
              onClick={() => router.push("/")}
              className="inline-flex w-full items-center justify-center rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Back to login
            </button>
          </div>
        )}

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
        </footer>
      </div>
    </div>
  );
}
