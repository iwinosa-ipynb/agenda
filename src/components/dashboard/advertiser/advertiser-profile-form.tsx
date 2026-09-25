"use client";

import { useActionState } from "react";

import { updateAdvertiserProfileAction } from "@/app/dashboard/_actions/advertiser";
import { Field, Input, Textarea } from "@/components/ui/field";
import { FormError, FormSuccess } from "@/components/ui/messages";
import { SubmitButton } from "@/components/ui/submit-button";
import type { ActionResult, AdvertiserProfileSummary } from "@/types";

export function AdvertiserProfileForm({
  profile,
}: {
  profile: AdvertiserProfileSummary;
}) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(
    updateAdvertiserProfileAction,
    null,
  );

  const fieldErrors = state && !state.success ? (state.fieldErrors ?? {}) : {};

  return (
    <form action={formAction} className="space-y-6" noValidate>
      <FormError message={state && !state.success ? state.error : null} />
      <FormSuccess message={state?.success ? "Profile saved." : null} />

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="Company name"
          htmlFor="companyName"
          error={fieldErrors.companyName?.[0]}
        >
          <Input
            id="companyName"
            name="companyName"
            defaultValue={profile.companyName}
            required
            invalid={Boolean(fieldErrors.companyName)}
          />
        </Field>

        <Field label="Website" htmlFor="website" error={fieldErrors.website?.[0]}>
          <Input
            id="website"
            name="website"
            type="url"
            defaultValue={profile.website ?? ""}
            placeholder="https://yourcompany.com"
            invalid={Boolean(fieldErrors.website)}
          />
        </Field>
      </div>

      <Field
        label="Company description"
        htmlFor="companyDescription"
        hint="Up to 1000 characters."
        error={fieldErrors.companyDescription?.[0]}
      >
        <Textarea
          id="companyDescription"
          name="companyDescription"
          defaultValue={profile.companyDescription ?? ""}
          maxLength={1000}
          placeholder="What your company does and why creators should want to work with you."
          invalid={Boolean(fieldErrors.companyDescription)}
        />
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="Location"
          htmlFor="location"
          error={fieldErrors.location?.[0]}
        >
          <Input
            id="location"
            name="location"
            defaultValue={profile.location ?? ""}
            placeholder="Lagos"
            invalid={Boolean(fieldErrors.location)}
          />
        </Field>

        <Field label="State" htmlFor="state" error={fieldErrors.state?.[0]}>
          <Input
            id="state"
            name="state"
            defaultValue={profile.state ?? ""}
            placeholder="Lagos State"
            invalid={Boolean(fieldErrors.state)}
          />
        </Field>

        <Field
          label="Country"
          htmlFor="country"
          error={fieldErrors.country?.[0]}
        >
          <Input
            id="country"
            name="country"
            defaultValue={profile.country ?? ""}
            placeholder="Nigeria"
            invalid={Boolean(fieldErrors.country)}
          />
        </Field>

        <Field
          label="Logo / profile image URL"
          htmlFor="logoUrl"
          hint="Paste a link to your logo for now."
          error={fieldErrors.logoUrl?.[0]}
        >
          <Input
            id="logoUrl"
            name="logoUrl"
            type="url"
            defaultValue={profile.logoUrl ?? ""}
            placeholder="https://…"
            invalid={Boolean(fieldErrors.logoUrl)}
          />
        </Field>
      </div>

      <div className="flex justify-end">
        <SubmitButton pendingLabel="Saving…">Save profile</SubmitButton>
      </div>
    </form>
  );
}
