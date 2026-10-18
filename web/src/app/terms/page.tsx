import Link from "next/link";
import { Share2 } from "lucide-react";

export const metadata = {
  title: "Terms of Service — FB Auto-Poster",
  description: "Terms governing your use of FB Auto-Poster.",
};

export default function TermsPage() {
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
        <h1 className="text-3xl font-semibold tracking-tight">Terms of Service</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Last updated: August 23, 2026
        </p>

        <div className="prose prose-slate mt-8 max-w-none space-y-6 text-sm leading-relaxed text-foreground">
          <section>
            <h2 className="text-lg font-semibold">1. Agreement to terms</h2>
            <p className="mt-2">
              These Terms of Service (&quot;Terms&quot;) govern your access to and use of
              FB Auto-Poster (&quot;the service&quot;, &quot;we&quot;, or &quot;us&quot;).
              By creating an account or using the service, you agree to be bound by these
              Terms. If you do not agree, you may not access or use the service.
            </p>
            <p className="mt-2">
              These Terms apply to all users of the service, including administrators,
              contributors, and any other person who interacts with the service.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">2. Description of the service</h2>
            <p className="mt-2">
              FB Auto-Poster is a self-hosted automation tool that allows you to schedule
              and publish posts to Facebook Pages you manage. The service lets you upload
              CSV files describing posts, connect one or more Facebook Pages via their
              access tokens, and run jobs that publish posts at defined intervals. The
              service does not provide Facebook accounts, access tokens, or media content
              — you must supply all of these yourself.
            </p>
            <p className="mt-2">
              The service is provided as-is, without any guarantee of uptime, support, or
              specific feature availability. Continued availability depends on Facebook&apos;s
              Graph API remaining compatible with the service&apos;s implementation.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">3. Account registration</h2>
            <p className="mt-2">To use the service, you must:</p>
            <ul className="ml-6 list-disc space-y-1">
              <li>Provide a valid email address and a password of at least 8 characters.</li>
              <li>Keep your password confidential and not share it with anyone.</li>
              <li>Be responsible for all activities that occur under your account.</li>
              <li>Notify us immediately of any unauthorized use of your account.</li>
            </ul>
            <p className="mt-2">
              We reserve the right to suspend or terminate accounts that violate these
              Terms, attempt to abuse rate limits, or compromise the security of the service.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">4. Acceptable use</h2>
            <p className="mt-2">You agree NOT to use the service to:</p>
            <ul className="ml-6 list-disc space-y-1">
              <li>Post content that violates Facebook&apos;s Community Standards or Terms of Service.</li>
              <li>Post spam, misleading, deceptive, or fraudulent content.</li>
              <li>Post content that infringes on the intellectual property rights of others.</li>
              <li>Post malware, phishing links, or any other malicious content.</li>
              <li>Attempt to access, tamper with, or disrupt the service or its underlying infrastructure.</li>
              <li>Use automated means to overload, scrape, or otherwise stress the service beyond its intended use.</li>
              <li>Resell, sublicense, or redistribute access to the service without permission.</li>
              <li>Use the service to publish content to Facebook Pages you do not own or have not been authorized to manage.</li>
            </ul>
            <p className="mt-2">
              Violation of these rules may result in immediate account suspension and
              removal of your content without prior notice.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">5. Facebook Pages and access tokens</h2>
            <p className="mt-2">
              You are solely responsible for obtaining and providing valid Facebook Page
              access tokens. You must only connect Pages that you own or have explicit
              permission to manage. You are responsible for ensuring that your use of the
              service complies with Facebook&apos;s Platform Terms, including their policies
              on automated posting.
            </p>
            <p className="mt-2">
              If Facebook revokes, suspends, or rate-limits a token you have provided, the
              service may fail to publish posts. We are not responsible for any failure
              caused by Facebook&apos;s actions or restrictions on your account or tokens.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">6. Intellectual property</h2>
            <p className="mt-2">
              The service software, including its source code, design, and documentation,
              is owned by its developer. You may use the service only as permitted by these
              Terms and any applicable license. You retain all rights to the content you
              upload, including CSV files, captions, and media assets. By uploading content,
              you grant the service a limited, non-exclusive license to process and
              temporarily store that content solely for the purpose of publishing it to
              Facebook on your behalf.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">7. Disclaimer of warranties</h2>
            <p className="mt-2">
              The service is provided &quot;AS IS&quot; and &quot;AS AVAILABLE&quot;,
              without warranties of any kind, whether express or implied. We do not
              guarantee that the service will be uninterrupted, error-free, secure, or
              that posts will be published at the exact scheduled time. We do not warrant
              that the service will remain compatible with future versions of the Facebook
              Graph API. Any reliance on the service is at your own risk.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">8. Limitation of liability</h2>
            <p className="mt-2">
              To the maximum extent permitted by applicable law, in no event shall the
              developer or any contributors be liable for any indirect, incidental,
              special, consequential, or punitive damages, or any loss of profits, data,
              or business opportunities, arising out of or related to your use of the
              service, whether based on warranty, contract, tort (including negligence),
              or any other legal theory, even if we have been advised of the possibility
              of such damages.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">9. Indemnification</h2>
            <p className="mt-2">
              You agree to indemnify and hold the developer and contributors harmless from
              any claims, damages, losses, or expenses (including reasonable legal fees)
              arising out of your use of the service, your violation of these Terms, or
              your violation of any third-party rights, including Facebook&apos;s terms
              or the rights of any Page owner whose token you have used.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">10. Service modifications</h2>
            <p className="mt-2">
              We reserve the right to modify, suspend, or discontinue the service, in whole
              or in part, at any time and without notice. We are not liable to you or any
              third party for any such modification, suspension, or discontinuance. We may
              also update these Terms from time to time; continued use of the service
              after changes are posted constitutes acceptance of the revised Terms.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">11. Account termination</h2>
            <p className="mt-2">
              You may delete your account at any time. Account deletion permanently removes
              all of your data, including connected Pages, jobs, and post records. We
              reserve the right to suspend or terminate your account if we believe you have
              violated these Terms or if your activity poses a risk to the service or other
              users.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">12. Governing law</h2>
            <p className="mt-2">
              These Terms shall be governed by and construed in accordance with applicable
              law, without regard to conflict-of-law principles. Any disputes arising under
              these Terms shall be resolved in the courts of competent jurisdiction.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">13. Contact</h2>
            <p className="mt-2">
              If you have questions about these Terms, please contact the developer using
              the contact information shown on the login page.
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
