"use client";

import { useActionState } from "react";
import Link from "next/link";

import { convertSelectedCandidateAction } from "@/app/dashboard/_actions/managed-brief";
import { Button } from "@/components/ui/button";
// Category labels come from the canonical CATEGORY_LABELS map — the same
// source every other category UI uses — so this form never renders raw enum
// values (FASHION, TECH). `constants.ts` imports its enum types with
// `import type`, which is erased at compile time, so this pulls no Prisma
// runtime into the client graph.
import { CATEGORY_LABELS } from "@/lib/constants";
import type { ActionResult } from "@/types";

const CATEGORY_OPTIONS = Object.entries(CATEGORY_LABELS);

type ConversionResult = {
  campaignId: string;
  candidateId: string;
  briefId: string;
};

type ConversionActionState = Awaited<
  ReturnType<typeof convertSelectedCandidateAction>
> | null;

/**
 * Advertiser control: create a DRAFT marketplace campaign from this brief's
 * SELECTED candidate (slice 5).
 *
 * The form collects exactly the fields the brief does not contain and the
 * Campaign model requires — including an EXPLICIT budget, because the brief's
 * informational budget is never silently promoted into the hard cap enforced
 * at acceptance time. There is deliberately NO quote field: the selected
 * creator still applies through the normal marketplace flow and authors their
 * own fixed quote. No CPM / price-per-view / verified-view field exists —
 * Agenda is fixed-rate by design.
 */
export function ManagedBriefConversionForm({
  briefId,
  candidateId,
  creatorName,
  accountPlatform,
  accountUsername,
  defaultTitle,
}: {
  briefId: string;
  candidateId: string;
  creatorName: string;
  accountPlatform: string;
  accountUsername: string;
  defaultTitle: string;
}) {
  const [state, formAction, isPending] = useActionState<ConversionActionState, FormData>(
    convertSelectedCandidateAction,
    null,
  );

  const converted = state?.success
    ? (state.data as unknown as ConversionResult)
    : null;

  return (
    <div className="space-y-4">
      <div className="space-y-2 text-sm leading-relaxed text-ink-soft">
        <p>
          Creates a <strong className="text-ink">DRAFT campaign</strong> for{" "}
          <strong className="text-ink">
            {creatorName} ({accountPlatform} · {accountUsername})
          </strong>
          . Nothing is published automatically.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>The selected creator still needs to apply to the campaign themselves.</li>
          <li>The creator sets their own fixed quote — it is never pre-filled.</li>
          <li>You must accept their application before an agreement exists.</li>
          <li>Funding happens only after an agreement exists.</li>
        </ul>
      </div>

      {converted ? (
        <p className="rounded-lg border border-line bg-surface-muted px-3.5 py-3 text-sm text-ink" role="status">
          Campaign created as a draft.{" "}
          <Link
            href={`/dashboard/campaigns/${converted.campaignId}`}
            className="font-medium text-accent hover:underline"
          >
            Open your campaign
          </Link>{" "}
          to review and publish it when it&apos;s ready.
        </p>
      ) : (
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="briefId" value={briefId} />
          <input type="hidden" name="candidateId" value={candidateId} />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Campaign title">
              <input
                name="title"
                type="text"
                required
                minLength={3}
                maxLength={120}
                defaultValue={defaultTitle}
                className={inputClass}
              />
            </Field>

            <Field label="Category">
              <select name="category" required defaultValue="" className={inputClass}>
                <option value="" disabled>
                  Choose a category…
                </option>
                {CATEGORY_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Target location">
              <input
                name="targetLocation"
                type="text"
                required
                minLength={2}
                maxLength={100}
                placeholder="e.g. Lagos, Nigeria"
                className={inputClass}
              />
            </Field>

            <Field label="Campaign budget (NGN)">
              <input
                name="budget"
                type="number"
                required
                min="0.01"
                step="0.01"
                placeholder="Set the real campaign budget"
                className={inputClass}
              />
            </Field>

            <Field label="Minimum followers">
              <input
                name="minimumFollowers"
                type="number"
                required
                min="0"
                step="1"
                defaultValue={0}
                className={inputClass}
              />
            </Field>

            <Field label="Creator slots">
              <input
                name="maxCreators"
                type="number"
                required
                min="1"
                max="50"
                step="1"
                defaultValue={1}
                className={inputClass}
              />
            </Field>

            <Field label="Application deadline (optional)">
              <input name="applicationDeadline" type="date" className={inputClass} />
            </Field>

            <Field label="Start date (optional)">
              <input name="startDate" type="date" className={inputClass} />
            </Field>

            <Field label="End date (optional)">
              <input name="endDate" type="date" className={inputClass} />
            </Field>
          </div>

          <Field label="Content requirements (optional)">
            <textarea
              name="contentRequirements"
              rows={3}
              maxLength={2000}
              className={inputClass}
            />
          </Field>

          <Field label="Rules (optional)">
            <textarea name="rules" rows={2} maxLength={2000} className={inputClass} />
          </Field>

          <Button type="submit" variant="accent" disabled={isPending}>
            {isPending ? "Creating draft campaign…" : "Create campaign from selected creator"}
          </Button>
        </form>
      )}

      {state && !state.success ? (
        <p className="text-sm text-danger" role="alert">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}

const inputClass =
  "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-sm font-medium text-ink">{label}</span>
      {children}
    </label>
  );
}
