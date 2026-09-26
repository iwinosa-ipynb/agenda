"use client";

import { useActionState } from "react";

import { createManagedBriefAction } from "@/app/dashboard/_actions/managed-brief";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { FormError } from "@/components/ui/messages";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  MANAGED_BRIEF_CHANNELS,
  PLATFORM_LABELS,
} from "@/lib/constants";
import type { ActionResult } from "@/types";

const CHANNEL_OPTIONS = MANAGED_BRIEF_CHANNELS.map((channel) => ({
  value: channel,
  label: PLATFORM_LABELS[channel],
}));

/**
 * Managed brief submission form (Agenda Managed V1). The action resolves the
 * advertiser from the session — no identity fields here. Channels are a
 * checkbox group (repeated `targetPlatforms` entries), matching the list
 * parsing in validation/managed-brief.ts.
 */
export function ManagedBriefForm() {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(
    createManagedBriefAction,
    null,
  );

  const fieldErrors =
    state && !state.success ? (state.fieldErrors ?? {}) : {};

  return (
    <form action={formAction} className="space-y-8" noValidate>
      <FormError message={state && !state.success ? state.error : null} />

      <section className="space-y-5">
        <h2 className="text-sm font-semibold tracking-[0.14em] text-accent uppercase">
          What you want to achieve
        </h2>

        <Field
          label="Marketing goal"
          htmlFor="campaignGoal"
          hint="One line — e.g. “Launch-week awareness for our new sneaker”."
          error={fieldErrors.campaignGoal?.[0]}
        >
          <Input
            id="campaignGoal"
            name="campaignGoal"
            placeholder="Launch-week awareness for our new sneaker"
            required
            invalid={Boolean(fieldErrors.campaignGoal)}
          />
        </Field>

        <Field
          label="Campaign description"
          htmlFor="description"
          hint="What the campaign is about, in your own words."
          error={fieldErrors.description?.[0]}
        >
          <Textarea
            id="description"
            name="description"
            rows={5}
            placeholder="Tell us what you're launching, who it's for, and what success looks like."
            required
            invalid={Boolean(fieldErrors.description)}
          />
        </Field>
      </section>

      <section className="space-y-5">
        <h2 className="text-sm font-semibold tracking-[0.14em] text-accent uppercase">
          Budget &amp; channels
        </h2>

        <div className="grid gap-5 sm:grid-cols-[1fr_10rem]">
          <Field
            label="Budget"
            htmlFor="budget"
            hint="Indicative — nothing is charged from this brief."
            error={fieldErrors.budget?.[0]}
          >
            <Input
              id="budget"
              name="budget"
              type="number"
              min="0"
              step="0.01"
              placeholder="500000"
              required
              invalid={Boolean(fieldErrors.budget)}
            />
          </Field>

          <Field
            label="Currency"
            htmlFor="currency"
            error={fieldErrors.currency?.[0]}
          >
            <Select id="currency" name="currency" defaultValue="NGN">
              <option value="NGN">NGN</option>
            </Select>
          </Field>
        </div>

        <Field
          label="Channels"
          htmlFor="targetPlatforms"
          hint="Where you'd like the campaign to run."
          error={fieldErrors.targetPlatforms?.[0]}
        >
          <div className="flex flex-wrap gap-2" id="targetPlatforms">
            {CHANNEL_OPTIONS.map((channel) => (
              <label
                key={channel.value}
                className="flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-3.5 py-2.5 text-sm text-ink transition-colors hover:border-accent"
              >
                <input
                  type="checkbox"
                  name="targetPlatforms"
                  value={channel.value}
                  className="size-4 accent-[var(--accent)]"
                />
                {channel.label}
              </label>
            ))}
          </div>
        </Field>

        <Field
          label="Target audience"
          htmlFor="targetAudience"
          hint="Who you're trying to reach."
          error={fieldErrors.targetAudience?.[0]}
        >
          <Textarea
            id="targetAudience"
            name="targetAudience"
            rows={3}
            placeholder="e.g. Nigerian men 18–34 interested in fitness and streetwear"
            required
            invalid={Boolean(fieldErrors.targetAudience)}
          />
        </Field>
      </section>

      <section className="space-y-5">
        <h2 className="text-sm font-semibold tracking-[0.14em] text-accent uppercase">
          Creator preferences
        </h2>

        <Field
          label="Creator requirements (optional)"
          htmlFor="creatorRequirements"
          hint="Anything you'd want in a creator — tone, audience fit, content style."
          error={fieldErrors.creatorRequirements?.[0]}
        >
          <Textarea
            id="creatorRequirements"
            name="creatorRequirements"
            rows={3}
            placeholder="e.g. Fitness-focused creators, Lagos-based, comfortable with long-form video"
          />
        </Field>
      </section>

      <div className="flex justify-end">
        <SubmitButton pendingLabel="Submitting…">Submit brief</SubmitButton>
      </div>
    </form>
  );
}
