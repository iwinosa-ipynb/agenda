/**
 * Verification email template (Stage 10).
 *
 * Pure functions — no I/O, no secrets in the output except the verification
 * link itself, which exists only in the rendered email. Kept separate from
 * the sending transport so the copy can be tested without any provider.
 */

import { VERIFICATION_TOKEN_TTL_MS } from "@/lib/verification-token";

const DEFAULT_APP_BASE_URL = "http://localhost:3000";

/**
 * Absolute verification URL for an email. APP_BASE_URL is the same env var
 * the OAuth callback routes already use, so deployments configure it once.
 */
export function buildVerificationUrl(
  token: string,
  appBaseUrl: string | undefined = process.env.APP_BASE_URL,
): string {
  const base = (appBaseUrl?.trim() || DEFAULT_APP_BASE_URL).replace(/\/+$/, "");

  return `${base}/auth/verify-email?token=${encodeURIComponent(token)}`;
}

type RenderArgs = {
  recipientEmail: string;
  verificationUrl: string;
  /** Minutes the link stays valid — shown so the user knows to act. */
  ttlMinutes?: number;
};

/**
 * Render the verification email. Returns an email-shaped object without
 * sending anything (sending is the transport's job).
 */
export function renderVerificationEmail({
  recipientEmail,
  verificationUrl,
  ttlMinutes = VERIFICATION_TOKEN_TTL_MS / (60 * 1000),
}: RenderArgs): {
  to: string;
  subject: string;
  text: string;
  html: string;
} {
  const subject = "Verify your email — Agenda";

  const text = [
    "Welcome to Agenda.",
    "",
    "Confirm this email address to activate your account:",
    "",
    verificationUrl,
    "",
    `This link expires in ${ttlMinutes} minutes and can be used once.`,
    "If you didn't create an Agenda account, you can ignore this email.",
  ].join("\n");

  const html = [
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:24px;line-height:1.6;color:#131210">',
    "<h2>Welcome to Agenda</h2>",
    "<p>Confirm this email address to activate your account.</p>",
    `<p><a href="${escapeHtmlAttribute(verificationUrl)}" style="display:inline-block;background:#0b6b43;color:#ffffff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Verify my email</a></p>`,
    `<p style="font-size:13px;color:#5f5b53">Or paste this link into your browser:<br>${escapeHtml(verificationUrl)}</p>`,
    `<p style="font-size:13px;color:#5f5b53">This link expires in ${ttlMinutes} minutes and can be used once.</p>`,
    "<p style=\"font-size:13px;color:#5f5b53\">If you didn't create an Agenda account, you can ignore this email.</p>",
    `<p style="font-size:12px;color:#8b877e">Sent to ${escapeHtml(recipientEmail)} by Agenda.</p>`,
    "</div>",
  ].join("\n");

  return { to: recipientEmail, subject, text, html };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
