import type { Metadata } from "next";
import Link from "next/link";

import { AuthFormShell } from "@/components/auth/auth-form-shell";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { inspectPasswordResetToken } from "@/services/password-reset.service";

export const metadata: Metadata = {
  title: "Reset your password",
};

/**
 * Password-reset landing page.
 *
 * The token arrives in the query string and is validated server-side
 * (never rendered, logged, or echoed). Consumption happens only on a
 * successful password submission, so a mere page visit never burns the
 * single use. Each token state maps to a clearly-worded screen.
 */
export default async function ResetPasswordPage({
  searchParams,
}: PageProps<"/auth/reset-password">) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : null;

  const inspection = await inspectPasswordResetToken(token);

  if (inspection.state === "valid") {
    return (
      <AuthFormShell
        title="Choose a new password"
        description="Pick a strong password you haven't used elsewhere."
        footer={
          <>
            Remembered your old password?{" "}
            <Link
              href="/auth/login"
              className="font-medium text-accent hover:underline"
            >
              Log in
            </Link>
          </>
        }
      >
        <ResetPasswordForm token={token as string} />
      </AuthFormShell>
    );
  }

  const heading =
    inspection.state === "missing"
      ? "Reset link required"
      : inspection.state === "expired"
        ? "Link expired"
        : inspection.state === "used"
          ? "Link already used"
          : "Invalid link";

  const explanation =
    inspection.state === "missing"
      ? "Open the password-reset link from your inbox, or request a fresh one below."
      : inspection.state === "expired"
        ? "This password-reset link has expired for your security. Request a fresh one below."
        : inspection.state === "used"
          ? "This reset link has already been used. If you didn't just change your password, request a new one below."
          : "We couldn't match this link to a pending password reset. Request a fresh one below.";

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
        {explanation}
      </div>
      <Link
        href="/auth/forgot-password"
        className="font-medium text-accent hover:underline"
      >
        Request a new reset link →
      </Link>
    </AuthFormShell>
  );
}
