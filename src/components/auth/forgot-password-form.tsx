"use client";

import { forgotPasswordAction } from "@/app/auth/forgot-password/actions";

import { useActionState } from "react";
import { Field, Input } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { ActionResult } from "@/types";

/**
 * Forgot-password form. Enumeration-safe: the same generic confirmation is
 * rendered whether or not the address belongs to an Agenda account, so the
 * UI never reveals account existence.
 */
export function ForgotPasswordForm() {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(
    forgotPasswordAction,
    null,
  );

  const fieldErrors = state && !state.success ? (state.fieldErrors ?? {}) : {};

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <Field
        label="Email address"
        htmlFor="forgot-password-email"
        error={fieldErrors.email?.[0]}
      >
        <Input
          id="forgot-password-email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          required
          invalid={Boolean(fieldErrors.email)}
        />
      </Field>

      <SubmitButton className="w-full" size="lg" pendingLabel="Sending…">
        Send reset link
      </SubmitButton>

      {state?.success ? (
        <p
          role="status"
          className="rounded-lg border border-accent/25 bg-accent-soft px-3.5 py-2.5 text-sm text-accent-strong"
        >
          If an account exists for that email, you&apos;ll receive a password
          reset link shortly.
        </p>
      ) : null}
    </form>
  );
}
