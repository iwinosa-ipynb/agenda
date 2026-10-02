"use client";

import Link from "next/link";
import { useActionState } from "react";

import {
  createCampaignAction,
  updateCampaignAction,
} from "@/app/dashboard/_actions/advertiser";
import { buttonClasses } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { FormError } from "@/components/ui/messages";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  CAMPAIGN_PLATFORMS,
  CATEGORY_LABELS,
  CONTENT_REQUIREMENT_SUGGESTIONS,
  PLATFORM_LABELS,
} from "@/lib/constants";
import type { ActionResult, AdvertiserCampaignDetail } from "@/types";

const CATEGORY_OPTIONS = Object.entries(CATEGORY_LABELS);
const PLATFORM_OPTIONS = CAMPAIGN_PLATFORMS.map((platform) => [
  platform,
  PLATFORM_LABELS[platform],
] as const);

function toInputDate(value: Date | null): string {
  if (!value) {
    return "";
  }

  return value.toISOString().slice(0, 10);
}

export function CampaignForm({
  campaign,
  budgetGuidance,
}: {
  /** Present when editing an existing campaign, absent when creating. */
  campaign?: AdvertiserCampaignDetail;
  /**
   * Marketplace budget guidance (Stage 12). When there is not enough real
   * data the message says so explicitly; the advertiser can always proceed
   * with their own budget — Agenda never overrides it.
   */
  budgetGuidance?: {
    dataAvailability: "AVAILABLE" | "INSUFFICIENT_DATA";
    explanation: string;
  } | null;
}) {
  const isEditing = Boolean(campaign);
  const isDraft = campaign?.status === "DRAFT";

  const [createState, createAction] = useActionState<
    ActionResult | null,
    FormData
  >(createCampaignAction, null);
  const [updateState, updateAction] = useActionState<
    ActionResult | null,
    FormData
  >(updateCampaignAction, null);

  const state = isEditing ? updateState : createState;
  const formAction = isEditing ? updateAction : createAction;
  const fieldErrors =
    state && !state.success ? (state.fieldErrors ?? {}) : {};

  return (
    <form action={formAction} className="space-y-8" noValidate>
      {isEditing && campaign ? (
        <input type="hidden" name="campaignId" value={campaign.id} />
      ) : null}

      <FormError message={state && !state.success ? state.error : null} />

      {isEditing && !isDraft ? (
        <p className="rounded-lg border border-dashed border-line-strong bg-surface-muted px-3.5 py-3 text-xs leading-relaxed text-ink-soft">
          This campaign is published — only descriptions, requirements, dates
          and tags can be edited. Platform, category, budget and creator slots
          are locked so creators always apply against the terms they saw.
        </p>
      ) : null}

      {/* Basic information */}
      <section className="space-y-5">
        <h2 className="text-sm font-semibold tracking-[0.14em] text-accent uppercase">
          Basic information
        </h2>

        <Field
          label="Campaign title"
          htmlFor="title"
          error={fieldErrors.title?.[0]}
        >
          <Input
            id="title"
            name="title"
            defaultValue={campaign?.title ?? ""}
            placeholder="Launch week push for our new sneaker"
            required
            invalid={Boolean(fieldErrors.title)}
            disabled={isEditing && !isDraft}
          />
        </Field>

        <Field
          label="Description"
          htmlFor="description"
          hint="What the campaign is about and what a great post looks like."
          error={fieldErrors.description?.[0]}
        >
          <Textarea
            id="description"
            name="description"
            defaultValue={campaign?.description ?? ""}
            rows={5}
            placeholder="Tell creators what you're launching, who you're trying to reach, and what success looks like."
            required
            invalid={Boolean(fieldErrors.description)}
          />
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Category"
            htmlFor="category"
            error={fieldErrors.category?.[0]}
          >
            <Select
              id="category"
              name="category"
              defaultValue={campaign?.category ?? ""}
              required
              invalid={Boolean(fieldErrors.category)}
              disabled={isEditing && !isDraft}
            >
              <option value="">Select a category</option>
              {CATEGORY_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Platform"
            htmlFor="platform"
            hint="TikTok and X are supported first."
            error={fieldErrors.platform?.[0]}
          >
            <Select
              id="platform"
              name="platform"
              defaultValue={campaign?.platform ?? ""}
              required
              invalid={Boolean(fieldErrors.platform)}
              disabled={isEditing && !isDraft}
            >
              <option value="">Select a platform</option>
              {PLATFORM_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field
          label="Tags (optional)"
          htmlFor="tags"
          hint="Comma-separated, up to 10 — e.g. Football, Basketball, Fitness."
          error={fieldErrors.tags?.[0]}
        >
          <Input
            id="tags"
            name="tags"
            defaultValue={campaign?.tags.join(", ") ?? ""}
            placeholder="Smartphones, AI, Gadgets"
            invalid={Boolean(fieldErrors.tags)}
          />
        </Field>
      </section>

      {/* Targeting */}
      <section className="space-y-5 border-t border-line pt-8">
        <h2 className="text-sm font-semibold tracking-[0.14em] text-accent uppercase">
          Targeting
        </h2>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Target country"
            htmlFor="targetCountry"
            hint="Optional — e.g. Nigeria."
            error={fieldErrors.targetCountry?.[0]}
          >
            <Input
              id="targetCountry"
              name="targetCountry"
              defaultValue={campaign?.targetCountry ?? ""}
              placeholder="Nigeria"
              invalid={Boolean(fieldErrors.targetCountry)}
            />
          </Field>

          <Field
            label="Target location"
            htmlFor="targetLocation"
            hint="City, state or region your audience is in."
            error={fieldErrors.targetLocation?.[0]}
          >
            <Input
              id="targetLocation"
              name="targetLocation"
              defaultValue={campaign?.targetLocation ?? ""}
              placeholder="Lagos"
              required
              invalid={Boolean(fieldErrors.targetLocation)}
              disabled={isEditing && !isDraft}
            />
          </Field>

          <Field
            label="Minimum follower count"
            htmlFor="minimumFollowers"
            hint="Creators below this count can't apply. Set 0 for no minimum."
            error={fieldErrors.minimumFollowers?.[0]}
          >
            <Input
              id="minimumFollowers"
              name="minimumFollowers"
              type="number"
              min={0}
              step={1}
              defaultValue={campaign?.minimumFollowers ?? 0}
              invalid={Boolean(fieldErrors.minimumFollowers)}
              disabled={isEditing && !isDraft}
            />
          </Field>
        </div>
      </section>

      {/* Budget & creators */}
      <section className="space-y-5 border-t border-line pt-8">
        <h2 className="text-sm font-semibold tracking-[0.14em] text-accent uppercase">
          Budget &amp; creators
        </h2>

        {budgetGuidance ? (
          <p className="rounded-lg border border-line bg-surface-muted px-3.5 py-3 text-xs leading-relaxed text-ink-soft">
            {budgetGuidance.dataAvailability === "AVAILABLE" ? (
              <>
                <span className="font-medium text-ink">Marketplace data:</span>{" "}
                {budgetGuidance.explanation}
              </>
            ) : (
              budgetGuidance.explanation
            )}
          </p>
        ) : null}

        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Total campaign budget"
            htmlFor="budget"
            hint="In Nigerian naira (NGN). Accepted creator quotes are paid from this budget."
            error={fieldErrors.budget?.[0]}
          >
            <Input
              id="budget"
              name="budget"
              type="number"
              min={1}
              step="0.01"
              defaultValue={
                campaign ? Number(campaign.budget).toString() : ""
              }
              placeholder="500000"
              required
              invalid={Boolean(fieldErrors.budget)}
              disabled={isEditing && !isDraft}
            />
          </Field>

          <Field
            label="Creators to accept"
            htmlFor="maxCreators"
            hint="How many creators can be accepted onto this campaign. Their quotes must fit the budget."
            error={fieldErrors.maxCreators?.[0]}
          >
            <Input
              id="maxCreators"
              name="maxCreators"
              type="number"
              min={1}
              step={1}
              defaultValue={campaign?.maxCreators ?? 1}
              invalid={Boolean(fieldErrors.maxCreators)}
              disabled={isEditing && !isDraft}
            />
          </Field>
        </div>

        <p className="text-xs leading-relaxed text-ink-faint">
          Creators set their own fees when they apply. You review each quote and
          choose who to accept — you never set a creator&apos;s pay directly,
          and accepted quotes are guaranteed to the creator.
        </p>
      </section>

      {/* Schedule */}
      <section className="space-y-5 border-t border-line pt-8">
        <h2 className="text-sm font-semibold tracking-[0.14em] text-accent uppercase">
          Schedule
        </h2>

        <div className="grid gap-5 sm:grid-cols-3">
          <Field
            label="Start date"
            htmlFor="startDate"
            error={fieldErrors.startDate?.[0]}
          >
            <Input
              id="startDate"
              name="startDate"
              type="date"
              defaultValue={toInputDate(campaign?.startDate ?? null)}
              invalid={Boolean(fieldErrors.startDate)}
            />
          </Field>

          <Field
            label="End date"
            htmlFor="endDate"
            error={fieldErrors.endDate?.[0]}
          >
            <Input
              id="endDate"
              name="endDate"
              type="date"
              defaultValue={toInputDate(campaign?.endDate ?? null)}
              invalid={Boolean(fieldErrors.endDate)}
            />
          </Field>

          <Field
            label="Application deadline"
            htmlFor="applicationDeadline"
            hint="Must be on or before the end date."
            error={fieldErrors.applicationDeadline?.[0]}
          >
            <Input
              id="applicationDeadline"
              name="applicationDeadline"
              type="date"
              defaultValue={toInputDate(campaign?.applicationDeadline ?? null)}
              invalid={Boolean(fieldErrors.applicationDeadline)}
            />
          </Field>
        </div>
      </section>

      {/* Content */}
      <section className="space-y-5 border-t border-line pt-8">
        <h2 className="text-sm font-semibold tracking-[0.14em] text-accent uppercase">
          Content
        </h2>

        <Field
          label="Content requirements"
          htmlFor="contentRequirements"
          hint="You write these — nothing is generated for you. These become the agreed deliverables."
          error={fieldErrors.contentRequirements?.[0]}
        >
          <Textarea
            id="contentRequirements"
            name="contentRequirements"
            defaultValue={campaign?.contentRequirements ?? ""}
            rows={4}
            placeholder={CONTENT_REQUIREMENT_SUGGESTIONS.join(
              ", ",
            )}
            invalid={Boolean(fieldErrors.contentRequirements)}
          />
        </Field>

        <Field
          label="Rules / instructions"
          htmlFor="rules"
          hint="Anything creators must or must not do."
          error={fieldErrors.rules?.[0]}
        >
          <Textarea
            id="rules"
            name="rules"
            defaultValue={campaign?.rules ?? ""}
            rows={4}
            placeholder="e.g. Keep the post public for at least 30 days. Don't use other brands' hashtags."
            invalid={Boolean(fieldErrors.rules)}
          />
        </Field>
      </section>

      <div className="flex flex-col gap-3 border-t border-line pt-6 sm:flex-row sm:justify-end">
        <Link
          href={
            isEditing && campaign
              ? `/dashboard/campaigns/${campaign.id}`
              : "/dashboard/campaigns"
          }
          className="inline-flex h-11 items-center justify-center px-4 text-sm text-ink-soft underline-offset-4 transition-colors hover:text-ink hover:underline pressed:text-ink"
        >
          Cancel
        </Link>

        {isEditing ? (
          <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row">
            <button
              type="submit"
              name="intent"
              value="draft"
              disabled={createState !== null && createState.success}
              className={buttonClasses({ variant: "outline", size: "md" })}
            >
              Save draft
            </button>
            <button
              type="submit"
              name="intent"
              value="publish"
              className={buttonClasses({ variant: "accent", size: "md", className: "px-6" })}
            >
              Publish campaign
            </button>
          </div>
        )}
      </div>
    </form>
  );
}
