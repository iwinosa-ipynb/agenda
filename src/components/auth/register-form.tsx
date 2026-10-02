"use client";

import { useActionState } from "react";

import { registerAction } from "@/app/auth/register/actions";
import { FormError } from "@/components/auth/auth-form-shell";
import { Field, Input } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { UserRole } from "@/types";
import type { ActionResult } from "@/types";

const ROLE_OPTIONS: Array<{
  value: UserRole;
  title: string;
  body: string;
}> = [
  {
    value: "CREATOR",
    title: "Creator",
    body: "Publish sponsored content and get paid your own fixed price.",
  },
  {
    value: "ADVERTISER",
    title: "Advertiser",
    body: "Launch campaigns and pay agreed prices through funded milestones.",
  },
];

export function RegisterForm({ defaultRole = "CREATOR" }: { defaultRole?: UserRole }) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(
    registerAction,
    null,
  );

  const fieldErrors = state && !state.success ? (state.fieldErrors ?? {}) : {};

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <FormError message={state && !state.success ? state.error : null} />

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink">
          I&apos;m joining as a
        </legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {ROLE_OPTIONS.map((option) => (
            <label key={option.value} className="relative cursor-pointer">
              <input
                type="radio"
                name="role"
                value={option.value}
                defaultChecked={option.value === defaultRole}
                className="peer sr-only"
              />
              <span className="flex h-full cursor-pointer flex-col gap-1 rounded-xl border border-line bg-surface p-4 transition-[color,background-color,border-color,transform] duration-150 ease-out hover:border-line-strong active:scale-[0.98] peer-checked:border-accent peer-checked:bg-accent-soft peer-focus-visible:ring-2 peer-focus-visible:ring-accent/40 motion-reduce:active:scale-100">
                <span className="text-sm font-semibold text-ink">
                  {option.title}
                </span>
                <span className="text-xs leading-relaxed text-ink-soft">
                  {option.body}
                </span>
              </span>
            </label>
          ))}
        </div>
        {fieldErrors.role ? (
          <p className="text-xs text-danger" role="alert">
            {fieldErrors.role[0]}
          </p>
        ) : null}
      </fieldset>

      <Field label="Name" htmlFor="name" error={fieldErrors.name?.[0]}>
        <Input
          id="name"
          name="name"
          autoComplete="name"
          placeholder="Your name or company"
          required
          invalid={Boolean(fieldErrors.name)}
        />
      </Field>

      <Field
        label="Email"
        htmlFor="email"
        error={fieldErrors.email?.[0]}
      >
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
        hint="At least 8 characters."
        error={fieldErrors.password?.[0]}
      >
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          placeholder="••••••••"
          required
          minLength={8}
          invalid={Boolean(fieldErrors.password)}
        />
      </Field>

      <SubmitButton className="w-full" size="lg" pendingLabel="Creating account…">
        Create account
      </SubmitButton>
    </form>
  );
}
