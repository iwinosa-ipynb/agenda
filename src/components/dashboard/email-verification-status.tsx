"use client";

import { useState } from "react";

import { resendVerificationAction } from "@/app/auth/verify-email/actions";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";

/**
 * Email-verification status for the authenticated dashboard (Stage 10).
 * Shows the account email with a verified / not-verified badge. The resend
 * action returns only status text — never token or challenge material.
 */
export function EmailVerificationStatus({
  email,
  emailVerifiedAt,
}: {
  email: string;
  emailVerifiedAt: Date | null;
}) {
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  async function handleResend() {
    setPending(true);
    setFeedback(null);

    try {
      const result = await resendVerificationAction();

      setFeedback(
        result.success
          ? { ok: true, text: "Verification email sent. Check your inbox." }
          : { ok: false, text: result.error },
      );
    } catch {
      setFeedback({
        ok: false,
        text: "Something went wrong. Please try again shortly.",
      });
    } finally {
      setPending(false);
    }
  }

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
          <Button
            variant="outline"
            size="sm"
            onClick={handleResend}
            disabled={pending}
          >
            {pending ? "Sending…" : "Verify email"}
          </Button>
        )}
      </div>

      {feedback ? (
        <div
          role={feedback.ok ? "status" : "alert"}
          className={
            feedback.ok
              ? "mt-4 rounded-lg border border-accent/25 bg-accent-soft px-3.5 py-2.5 text-sm text-accent-strong"
              : "mt-4 rounded-lg border border-danger/25 bg-danger-soft px-3.5 py-2.5 text-sm text-danger"
          }
        >
          {feedback.text}
        </div>
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
