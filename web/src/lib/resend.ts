/**
 * Resend.com email sender.
 *
 * Uses Resend's HTTP API directly (no SDK dependency).
 * Docs: https://resend.com/docs/api-reference/emails/send-email
 *
 * Env:
 *   RESEND_API_KEY  — secret from https://resend.com/api-keys
 *   MAIL_FROM       — verified sender address (e.g. onboarding@yourdomain.com)
 *   APP_BASE_URL    — public base URL, used for links inside email body
 */

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  text?: string
): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM || "onboarding@resend.dev";

  if (!apiKey) {
    console.error("[resend] RESEND_API_KEY is not set in environment");
    return {
      success: false,
      error: "Email service is not configured. Set RESEND_API_KEY in .env",
    };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        html,
        text: text || html.replace(/<[^>]+>/g, ""),
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error("[resend] API error:", res.status, errBody);
      return {
        success: false,
        error: `Resend API error (${res.status})`,
      };
    }

    const data = await res.json();
    return { success: true, messageId: data.id };
  } catch (err) {
    console.error("[resend] Network error:", err);
    return { success: false, error: "Failed to send email" };
  }
}

/**
 * Send the 6-digit password reset code to a user's email.
 * Returns true if the email was accepted by Resend.
 */
export async function sendPasswordResetEmail(
  to: string,
  code: string
): Promise<SendEmailResult> {
  const appUrl = process.env.APP_BASE_URL || "http://localhost:3000";
  const subject = "Your FB Auto-Poster password reset code";

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${subject}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; background-color: #f8fafc;">
  <div style="background: #ffffff; border-radius: 8px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.08);">
    <h1 style="font-size: 20px; font-weight: 600; color: #0f172a; margin: 0 0 16px 0;">Reset your password</h1>
    <p style="font-size: 14px; color: #475569; line-height: 1.6; margin: 0 0 24px 0;">
      We received a request to reset the password for your FB Auto-Poster account.
      Use the code below to complete the reset. This code will expire in 10 minutes.
    </p>
    <div style="background: #f1f5f9; border-radius: 8px; padding: 20px; text-align: center; margin: 24px 0;">
      <div style="font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #2563eb; font-family: 'Courier New', monospace;">
        ${code}
      </div>
    </div>
    <p style="font-size: 14px; color: #475569; line-height: 1.6; margin: 0 0 12px 0;">
      If you didn't request this password reset, you can safely ignore this email.
      Your password will not be changed.
    </p>
    <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 24px 0;">
    <p style="font-size: 12px; color: #94a3b8; margin: 0;">
      FB Auto-Poster &middot; <a href="${appUrl}" style="color: #2563eb; text-decoration: none;">${appUrl}</a>
    </p>
  </div>
</body>
</html>
`;

  const text = `Reset your password.

We received a request to reset the password for your FB Auto-Poster account.
Use the code below to complete the reset. This code will expire in 10 minutes.

Code: ${code}

If you didn't request this password reset, you can safely ignore this email.

FB Auto-Poster - ${appUrl}`;

  return sendEmail(to, subject, html, text);
}
