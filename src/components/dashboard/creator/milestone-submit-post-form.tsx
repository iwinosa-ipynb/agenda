"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";

import { submitMilestonePostAction } from "@/app/dashboard/_actions/milestones";
import { Button } from "@/components/ui/button";
import { CAMPAIGN_PLATFORMS, PLATFORM_LABELS } from "@/lib/constants";
import type { ActionResult } from "@/types";

/**
 * Stage 13C — creator submits a published post against a SPECIFIC milestone.
 * The milestone is fixed by the surrounding card (never chosen client-side);
 * identity comes from the session and every eligibility/funding/duplicate
 * check runs server-side before Stage 9 verification runs.
 */
export function MilestoneSubmitPostForm({
  milestoneId,
  platform,
}: {
  milestoneId: string;
  /** The agreement's frozen platform — submissions must match it. */
  platform: keyof typeof PLATFORM_LABELS;
}) {
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    submitMilestonePostAction,
    null,
  );

  const router = useRouter();

  useEffect(() => {
    if (state?.success) {
      router.refresh();
    }
  }, [state, router]);

  const platformChoices = CAMPAIGN_PLATFORMS.includes(
    platform as (typeof CAMPAIGN_PLATFORMS)[number],
  )
    ? [platform]
    : [...CAMPAIGN_PLATFORMS];

  return (
    <form action={formAction} className="mt-5 space-y-3 border-t border-line pt-5">
      <input type="hidden" name="milestoneId" value={milestoneId} />

      <label
        htmlFor={`platform-${milestoneId}`}
        className="block text-sm font-medium text-ink"
      >
        Platform
      </label>
      <select
        id={`platform-${milestoneId}`}
        name="platform"
        required
        className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none sm:max-w-xs"
      >
        {platformChoices.map((choice) => (
          <option key={choice} value={choice}>
            {PLATFORM_LABELS[choice]}
          </option>
        ))}
      </select>

      <label
        htmlFor={`postUrl-${milestoneId}`}
        className="block text-sm font-medium text-ink"
      >
        Published post URL
      </label>
      <input
        id={`postUrl-${milestoneId}`}
        name="postUrl"
        type="url"
        required
        placeholder="https://"
        className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
      />

      <label
        htmlFor={`caption-${milestoneId}`}
        className="block text-sm font-medium text-ink"
      >
        Caption (optional)
      </label>
      <textarea
        id={`caption-${milestoneId}`}
        name="caption"
        rows={2}
        maxLength={500}
        className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
      />

      <Button type="submit" variant="accent" size="sm" disabled={isPending}>
        {isPending ? "Submitting & verifying…" : "Submit Published Post"}
      </Button>

      <p className="text-xs leading-relaxed text-ink-soft">
        Verification runs automatically against the platform. Payment is based
        on fulfilling the agreed deliverables — never on views, likes or
        comments.
      </p>

      {state && !state.success ? (
        <p className="text-sm text-danger" role="alert">
          {state.error}
        </p>
      ) : null}
      {state?.success ? (
        <p className="text-sm text-accent-strong" role="status">
          Submission recorded and verified where possible — see the status below.
        </p>
      ) : null}
    </form>
  );
}
