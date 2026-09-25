import type { Metadata } from "next";
import Link from "next/link";

import { AuthFormShell } from "@/components/auth/auth-form-shell";
import { ResendVerificationForm } from "@/components/auth/resend-verification-form";
import { verifyEmailWithToken } from "@/services/email-verification.service";

export const metadata: Metadata = {
  title: "Verify your email",
};

/**
 * Email-verification landing page (Stage 10).
 *
 * The token arrives in the query string, is consumed server-side exactly
 * once, and is never rendered, logged, or echoed back. Each verification
 * outcome maps to a clearly-worded state; expired/invalid states offer the
 * enumeration-safe resend form.
 */
export default async function VerifyEmailPage({
  searchParams,
}: PageProps<"/auth/verify-email">) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : null;

  if (!token) {
    return (
      <AuthFormShell
        title="Verify your email"
        description="Open the verification link from your inbox, or request a new one below."
      >
        <ResendVerificationForm />
      </AuthFormShell>
    );
  }

  const result = await verifyEmailWithToken(token);

  if (result.outcome === "verified") {
    return (
      <AuthFormShell
        title="Email verified"
        description="Your email address is confirmed. You're all set."
        footer={
          <Link
            href="/dashboard"
            className="font-medium text-accent hover:underline"
          >
            Continue to your dashboard →
          </Link>
        }
      >
        <div
          role="status"
          className="rounded-lg border border-accent/25 bg-accent-soft px-4 py-3 text-sm font-medium text-accent-strong"
        >
          ✓ {result.message}
        </div>
      </AuthFormShell>
    );
  }

  if (result.outcome === "already_verified") {
    return (
      <AuthFormShell
        title="Already verified"
        description="This email address has already been verified. No action needed."
        footer={
          <Link
            href="/dashboard"
            className="font-medium text-accent hover:underline"
          >
            Continue to your dashboard →
          </Link>
        }
      >
        <div
          role="status"
          className="rounded-lg border border-accent/25 bg-accent-soft px-4 py-3 text-sm text-accent-strong"
        >
          Your email is already verified.
        </div>
      </AuthFormShell>
    );
  }

  const heading =
    result.outcome === "expired"
      ? "Link expired"
      : result.outcome === "used"
        ? "Link already used"
        : "Invalid link";

  const explanation =
    result.outcome === "expired"
      ? "This verification link has expired. Request a fresh one below — we'll send a new email if the address belongs to an Agenda account."
      : result.outcome === "used"
        ? "This link has already been used. If your email isn't marked verified in your dashboard yet, request a new link below."
        : "We couldn't match this link to a pending verification. Request a fresh one below.";

  return (
    <AuthFormShell
      title={heading}
      description={explanation}
      footer={
        <>
          Need help?{" "}
          <Link
            href="/auth/login"
            className="font-medium text-accent hover:underline"
          >
            Log in
          </Link>
        </>
      }
    >
      <div
        role="alert"
        className="mb-6 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning"
      >
        {result.message}
      </div>
      <ResendVerificationForm />
    </AuthFormShell>
  );
}
