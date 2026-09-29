"use client";

import { useActionState } from "react";

import { resetPasswordAction } from "@/app/auth/reset-password/actions";
import { FormError } from "@/components/auth/auth-form-shell";
import { Field, Input } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { ActionResult } from "@/types";

/**
 * New-password form for a valid reset token. Token validation and
 * consumption happen server-side; this form carries the password fields and
 * renders success/error states. Expired/used/invalid tokens surface a
 * user-actionable message from the action.
 */
export function ResetPasswordForm({ token }: { token: string }) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(
    async (prevState, formData) => resetPasswordAction(token, prevState, formData),
    null,
  );

  const fieldErrors = state && !state.success ? (state.fieldErrors ?? {}) : {};

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError message={state && !state.success ? state.error : null} />

      <Field
        label="New password"
        htmlFor="new-password"
        error={fieldErrors.password?.[0]}
        hint="At least 8 characters."
      >
        <Input
          id="new-password"
          name="password"
          type="password"
          autoComplete="new-password"
          placeholder="••••••••"
          required
          invalid={Boolean(fieldErrors.password)}
        />
      </Field>

      <Field
        label="Confirm new password"
        htmlFor="confirm-password"
        error={fieldErrors.confirmPassword?.[0]}
      >
        <Input
          id="confirm-password"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          placeholder="••••••••"
          required
          invalid={Boolean(fieldErrors.confirmPassword)}
        />
      </Field>

      <SubmitButton className="w-full" size="lg" pendingLabel="Updating…">
        Update password
      </SubmitButton>

      {state?.success ? (
        <p
          role="status"
          className="rounded-lg border border-accent/25 bg-accent-soft px-3.5 py-2.5 text-sm text-accent-strong"
        >
          Password updated. You can now log in with your new password.
        </p>
      ) : null}
    </form>
  );
}
