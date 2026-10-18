import Link from "next/link";
import { Share2 } from "lucide-react";

export const metadata = {
  title: "Privacy Policy — FB Auto-Poster",
  description: "How FB Auto-Poster collects, uses, and protects your data.",
};

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-muted/30">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Share2 className="h-5 w-5" />
          </div>
          <span className="text-base font-semibold tracking-tight">FB Auto-Poster</span>
          <Link
            href="/"
            className="ml-auto text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Back to login
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-3xl font-semibold tracking-tight">Privacy Policy</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Last updated: August 23, 2026
        </p>

        <div className="prose prose-slate mt-8 max-w-none space-y-6 text-sm leading-relaxed text-foreground">
          <section>
            <h2 className="text-lg font-semibold">1. Overview</h2>
            <p className="mt-2">
              FB Auto-Poster (&quot;we&quot;, &quot;us&quot;, or &quot;the service&quot;) is a
              self-hosted tool that lets you schedule and automatically publish posts to
              Facebook Pages you manage. This Privacy Policy explains what data we collect,
              why we collect it, how long we keep it, and the choices you have.
            </p>
            <p className="mt-2">
              By creating an account and using the service, you agree to the practices
              described in this Privacy Policy. If you do not agree, you should not use the
              service. This policy applies only to the FB Auto-Poster application and not to
              any third-party services such as Facebook, Resend, or your hosting provider,
              each of which has its own privacy practices you should review separately.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">2. Account information we collect</h2>
            <p className="mt-2">When you register an account, we collect:</p>
            <ul className="ml-6 list-disc space-y-1">
              <li><strong>Email address</strong> — used for login, account notifications, and password reset codes.</li>
              <li><strong>Username</strong> — a public-facing display name shown inside the dashboard.</li>
              <li><strong>Password</strong> — stored only as a bcrypt hash (one-way, salted). We never store or log your raw password.</li>
            </ul>
            <p className="mt-2">
              We do not collect your real name, phone number, location, or any other
              personally identifying information unless you explicitly provide it.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">3. Facebook Page credentials</h2>
            <p className="mt-2">
              To publish posts on your behalf, the service stores the following for each
              Facebook Page you connect:
            </p>
            <ul className="ml-6 list-disc space-y-1">
              <li><strong>Page Access Token</strong> — the Facebook Page token you provide. This token is encrypted at rest using AES-256-GCM with a key stored only in server environment variables.</li>
              <li><strong>Page ID</strong> — the Facebook Page identifier.</li>
              <li><strong>Graph API version</strong> — defaults to v20.0.</li>
            </ul>
            <p className="mt-2">
              These credentials are never logged in plain text, never exposed to the
              browser, and never sent to any service other than Facebook&apos;s Graph API.
              You can delete a connected Page at any time, which immediately removes its
              token from the database.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">4. Post content and uploads</h2>
            <p className="mt-2">
              When you upload a CSV file and media assets (images, videos) for posting, that
              content is stored on the server in an upload directory and a database record is
              kept of each scheduled and published post. Uploaded CSV files are automatically
              deleted after a retention period (default: 24 hours). Media files are retained
              for the lifetime of the job and removed when the job is deleted or expires.
            </p>
            <p className="mt-2">
              Job history records (post status, scheduled times, Facebook post IDs, error
              messages) are retained for a default of 15 days and then automatically purged.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">5. Password reset codes</h2>
            <p className="mt-2">
              When you request a password reset, a 6-digit code is generated and emailed to
              you via our email provider (Resend). The code itself is stored only as a bcrypt
              hash in the database, never in plain text. Each code expires after 10 minutes
              and is invalidated immediately after a successful reset. We limit reset
              requests to 5 per 10 minutes per IP address to prevent abuse.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">6. Cookies and sessions</h2>
            <p className="mt-2">
              After you log in, the service sets a single <code>fbp_session</code> cookie
              in your browser. This cookie is marked <strong>HttpOnly</strong> (not readable
              by JavaScript), <strong>SameSite=Strict</strong> (not sent on cross-site
              requests), and <strong>Secure</strong> in production (only sent over HTTPS).
              The cookie contains a signed JWT identifying your user ID. It expires after
              24 hours. We do not use any analytics, tracking, or advertising cookies.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">7. Third-party services</h2>
            <p className="mt-2">The service integrates with the following third parties:</p>
            <ul className="ml-6 list-disc space-y-1">
              <li><strong>Facebook Graph API</strong> — used to publish posts to your Pages using the access token you provided.</li>
              <li><strong>Resend</strong> — used to send password reset emails. Only your email address and the reset code are passed to Resend.</li>
            </ul>
            <p className="mt-2">
              Each of these services has its own privacy policy. We encourage you to review
              them. We do not share your data with any advertising networks or data brokers.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">8. Security measures</h2>
            <p className="mt-2">We take the following measures to protect your data:</p>
            <ul className="ml-6 list-disc space-y-1">
              <li>Passwords hashed with bcrypt (cost factor 12).</li>
              <li>Page access tokens encrypted at rest with AES-256-GCM.</li>
              <li>Reset codes hashed with bcrypt and short-lived (10 minutes).</li>
              <li>JWT session tokens signed with a server-only secret.</li>
              <li>Rate limiting on login, registration, and password reset endpoints.</li>
              <li>HTTP security headers (HSTS, X-Frame-Options: DENY, nosniff, Referrer-Policy).</li>
              <li>No third-party analytics or tracking scripts.</li>
            </ul>
            <p className="mt-2">
              No method of transmission or storage is 100% secure. If you believe your
              account has been compromised, please change your password immediately and
              reconnect any Facebook Pages.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">9. Your rights</h2>
            <p className="mt-2">You have the following rights regarding your data:</p>
            <ul className="ml-6 list-disc space-y-1">
              <li><strong>Access</strong> — you can view your account information from the dashboard.</li>
              <li><strong>Correction</strong> — you can update your account details at any time.</li>
              <li><strong>Deletion</strong> — you can delete your account, which removes all associated data (accounts, jobs, posts, reset codes) via database cascade.</li>
              <li><strong>Revocation</strong> — you can delete any connected Facebook Page to revoke its access token at any time.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold">10. Data retention</h2>
            <p className="mt-2">
              We retain your account information for as long as your account is active. CSV
              files are deleted after 24 hours. Job and post records are deleted after 15
              days. Password reset codes are deleted or invalidated after 10 minutes. When
              you delete your account, all of your data is permanently removed from the
              database and cannot be recovered.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">11. Changes to this policy</h2>
            <p className="mt-2">
              We may update this Privacy Policy from time to time. When we do, we will
              revise the &quot;Last updated&quot; date at the top of this page. We
              encourage you to review this page periodically to stay informed about how we
              protect your data.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">12. Contact</h2>
            <p className="mt-2">
              If you have questions about this Privacy Policy or your data, you can reach
              out via the developer contact information shown on the login page.
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
