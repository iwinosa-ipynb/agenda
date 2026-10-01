"use client";

import { useSearchParams } from "next/navigation";

import { resendVerificationAndRedirectAction } from "@/app/auth/verify-email/actions";
import { Badge, Card } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";

/**
 * Email-verification status for the authenticated dashboard (Stage 10).
 * Shows the account email with a verified / not-verified badge. The resend
 * action returns only status text — never token or challenge material.
 *
 * The resend is a real server-action form that resolves with a plain
 * `?verification=…` redirect and reads its feedback from the URL. That keeps
 * the button working end-to-end — including visible feedback — on browsers
 * below the supported JavaScript baseline (older phones), where React never
 * hydrates and a state-driven action response would render nothing. A browser
 * without form support at all cannot press the button; the explanatory line
 * below the card is the fallback there.
 */
export function EmailVerificationStatus({
  email,
  emailVerifiedAt,
}: {
  email: string;
  emailVerifiedAt: Date | null;
}) {
  const searchParams = useSearchParams();
  const resendStatus = searchParams.get("verification");

  const resendSent = resendStatus === "resend-sent";
  const resendFailed = resendStatus === "resend-failed";

  return (
    <Card className="p-6">
      <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
        Account email
      </h2>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">
            Email
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-ink">
              {email}
            </span>
            {emailVerifiedAt ? (
              <Badge tone="accent">✓ Verified</Badge>
            ) : (
              <Badge tone="warning">⚠ Not verified</Badge>
            )}
          </div>
        </div>

        {emailVerifiedAt ? null : (
          <form action={resendVerificationAndRedirectAction}>
            <input type="hidden" name="redirectTo" value="/dashboard/profile" />
            <SubmitButton variant="outline" size="sm" pendingLabel="Sending…">
              Verify email
            </SubmitButton>
          </form>
        )}
      </div>

      {resendSent ? (
        <p
          role="status"
          className="mt-4 rounded-lg border border-accent/25 bg-accent-soft px-3.5 py-2.5 text-sm text-accent-strong"
        >
          Verification email sent. Check your inbox.
        </p>
      ) : null}

      {resendFailed ? (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-danger/25 bg-danger-soft px-3.5 py-2.5 text-sm text-danger"
        >
          Couldn&apos;t send the verification email. The email service may not
          be configured on this server yet, or the resend limit was reached —
          try again shortly or contact support.
        </p>
      ) : null}

      {emailVerifiedAt ? null : (
        <p className="mt-4 text-xs leading-relaxed text-ink-faint">
          Verify your email before connecting a social account or
          participating in campaigns.
        </p>
      )}
    </Card>
  );
}
