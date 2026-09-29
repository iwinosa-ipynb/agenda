"use client";

import Link from "next/link";
import { useActionState } from "react";

import { loginAction } from "@/app/auth/login/actions";
import { FormError } from "@/components/auth/auth-form-shell";
import { Field, Input } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { ActionResult } from "@/types";

export function LoginForm() {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(
    loginAction,
    null,
  );

  const fieldErrors = state && !state.success ? (state.fieldErrors ?? {}) : {};

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError message={state && !state.success ? state.error : null} />

      <Field label="Email" htmlFor="email" error={fieldErrors.email?.[0]}>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          required
          invalid={Boolean(fieldErrors.email)}
        />
      </Field>

      <Field
        label="Password"
        htmlFor="password"
        error={fieldErrors.password?.[0]}
      >
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          placeholder="••••••••"
          required
          invalid={Boolean(fieldErrors.password)}
        />
      </Field>

      <div className="flex justify-end">
        <Link
          href="/auth/forgot-password"
          className="text-sm font-medium text-accent hover:underline"
        >
          Forgot password?
        </Link>
      </div>

      <SubmitButton className="w-full" size="lg" pendingLabel="Logging in…">
        Log in
      </SubmitButton>
    </form>
  );
}
