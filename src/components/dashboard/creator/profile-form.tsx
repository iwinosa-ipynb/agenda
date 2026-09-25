"use client";

import { useActionState } from "react";

import { updateCreatorProfileAction } from "@/app/dashboard/_actions/profile";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { FormError, FormSuccess } from "@/components/ui/messages";
import { SubmitButton } from "@/components/ui/submit-button";
import { CATEGORY_LABELS } from "@/lib/constants";
import type { ActionResult, CreatorProfileSummary } from "@/types";

export function ProfileForm({ profile }: { profile: CreatorProfileSummary }) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(
    updateCreatorProfileAction,
    null,
  );

  const fieldErrors = state && !state.success ? (state.fieldErrors ?? {}) : {};

  return (
    <form action={formAction} className="space-y-6" noValidate>
      <FormError message={state && !state.success ? state.error : null} />
      <FormSuccess message={state?.success ? "Profile saved." : null} />

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="Display name"
          htmlFor="displayName"
          error={fieldErrors.displayName?.[0]}
        >
          <Input
            id="displayName"
            name="displayName"
            defaultValue={profile.name}
            required
            invalid={Boolean(fieldErrors.displayName)}
          />
        </Field>

        <Field
          label="Username"
          htmlFor="username"
          hint="Shown to advertisers."
          error={fieldErrors.username?.[0]}
        >
          <Input
            id="username"
            name="username"
            defaultValue={profile.username}
            required
            invalid={Boolean(fieldErrors.username)}
          />
        </Field>
      </div>

      <Field
        label="Bio"
        htmlFor="bio"
        hint="Up to 280 characters."
        error={fieldErrors.bio?.[0]}
      >
        <Textarea
          id="bio"
          name="bio"
          defaultValue={profile.bio ?? ""}
          maxLength={280}
          placeholder="Tell advertisers what you create and who you reach."
          invalid={Boolean(fieldErrors.bio)}
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

        <Field label="Country" htmlFor="country" error={fieldErrors.country?.[0]}>
          <Input
            id="country"
            name="country"
            defaultValue={profile.country ?? ""}
            placeholder="Nigeria"
            invalid={Boolean(fieldErrors.country)}
          />
        </Field>

        <Field
          label="Category"
          htmlFor="category"
          error={fieldErrors.category?.[0]}
        >
          <Select
            id="category"
            name="category"
            defaultValue={profile.category ?? ""}
            invalid={Boolean(fieldErrors.category)}
          >
            <option value="">Select a category</option>
            {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Follower count"
          htmlFor="followerCount"
          hint="Self-reported. Not used for eligibility or payouts until verified."
          error={fieldErrors.followerCount?.[0]}
        >
          <Input
            id="followerCount"
            name="followerCount"
            type="number"
            min={0}
            step={1}
            defaultValue={profile.followerCount}
            invalid={Boolean(fieldErrors.followerCount)}
          />
        </Field>

        <Field
          label="Profile photo URL"
          htmlFor="profileImage"
          hint="Paste a link to an image for now."
          error={fieldErrors.profileImage?.[0]}
        >
          <Input
            id="profileImage"
            name="profileImage"
            type="url"
            defaultValue={profile.profileImage ?? ""}
            placeholder="https://…"
            invalid={Boolean(fieldErrors.profileImage)}
          />
        </Field>
      </div>

      <div className="flex justify-end">
        <SubmitButton pendingLabel="Saving…">Save profile</SubmitButton>
      </div>
    </form>
  );
}
