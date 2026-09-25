"use client";

import { useActionState, useEffect, useRef } from "react";

import { addSocialAccountAction } from "@/app/dashboard/_actions/social-accounts";
import { Field, Input, Select } from "@/components/ui/field";
import { FormError, FormSuccess } from "@/components/ui/messages";
import { SubmitButton } from "@/components/ui/submit-button";
import { CONNECTABLE_PLATFORMS, PLATFORM_LABELS } from "@/lib/constants";
import type { ActionResult } from "@/types";

export function SocialAccountForm() {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(
    addSocialAccountAction,
    null,
  );
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.success) {
      formRef.current?.reset();
    }
  }, [state]);

  const fieldErrors = state && !state.success ? (state.fieldErrors ?? {}) : {};

  return (
    <form ref={formRef} action={formAction} className="space-y-5" noValidate>
      <FormError message={state && !state.success ? state.error : null} />
      <FormSuccess
        message={
          state?.success
            ? "Account added. It's pending verification."
            : null
        }
      />

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="Platform"
          htmlFor="platform"
          error={fieldErrors.platform?.[0]}
        >
          <Select
            id="platform"
            name="platform"
            defaultValue={CONNECTABLE_PLATFORMS[0]}
            invalid={Boolean(fieldErrors.platform)}
          >
            {CONNECTABLE_PLATFORMS.map((platform) => (
              <option key={platform} value={platform}>
                {PLATFORM_LABELS[platform]}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Username"
          htmlFor="username"
          hint="Without the @ symbol."
          error={fieldErrors.username?.[0]}
        >
          <Input
            id="username"
            name="username"
            placeholder="yourhandle"
            required
            invalid={Boolean(fieldErrors.username)}
          />
        </Field>
      </div>

      <Field
        label="Profile URL"
        htmlFor="profileUrl"
        error={fieldErrors.profileUrl?.[0]}
      >
        <Input
          id="profileUrl"
          name="profileUrl"
          type="url"
          placeholder="https://tiktok.com/@yourhandle"
          required
          invalid={Boolean(fieldErrors.profileUrl)}
        />
      </Field>

      <SubmitButton pendingLabel="Adding…">Add account</SubmitButton>
    </form>
  );
}
