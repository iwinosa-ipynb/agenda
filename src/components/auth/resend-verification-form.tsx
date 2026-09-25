"use client";

import { useActionState } from "react";

import { requestVerificationForEmailAction } from "@/app/auth/verify-email/actions";
import { Field, Input } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { ActionResult } from "@/types";

/**
 * Logged-out resend form. Always shows the same generic confirmation
 * regardless of whether the address belongs to an Agenda account.
 */
export function ResendVerificationForm() {
  const [state, formAction] = useActionState<
    ActionResult | null,
    FormData
  >(requestVerificationForEmailAction, null);

  return (
    <form action={formAction} className="space-y-3" noValidate>
      <Field
        label="Email address"
        htmlFor="resend-email"
        error={
          state && !state.success
            ? state.fieldErrors?.email?.[0]
            : undefined
        }
      >
        <Input
          id="resend-email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          required
        />
      </Field>

      <SubmitButton size="md" pendingLabel="Sending…">
        Send verification link
      </SubmitButton>

      {state?.success ? (
        <p
          role="status"
          className="rounded-lg border border-accent/25 bg-accent-soft px-3.5 py-2.5 text-sm text-accent-strong"
        >
          If that email belongs to an Agenda account, a verification link is
          on its way.
        </p>
      ) : null}
    </form>
  );
}
