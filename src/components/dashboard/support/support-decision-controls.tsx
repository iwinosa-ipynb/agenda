"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";

import { recordSupportDecisionAction } from "@/app/dashboard/_actions/support";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/types";

/**
 * Explicit support decision controls. One audited outcome per submission;
 * amounts are never part of the form.
 */
export function SupportDecisionControls({ milestoneId }: { milestoneId: string }) {
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    recordSupportDecisionAction,
    null,
  );

  const router = useRouter();

  useEffect(() => {
    if (state?.success) {
      router.refresh();
    }
  }, [state, router]);

  return (
    <div className="mt-4 space-y-4">
      <form action={formAction} className="space-y-3">
        <input type="hidden" name="milestoneId" value={milestoneId} />

        <label
          htmlFor={`decision-${milestoneId}`}
          className="block text-sm font-medium text-ink"
        >
          Decision
        </label>
        <select
          id={`decision-${milestoneId}`}
          name="decision"
          required
          className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
        >
          <option value="RELEASE_PAYMENT">Release payment — work fulfilled</option>
          <option value="REQUEST_CORRECTION">Request correction — back to the creator</option>
          <option value="CANCEL_AFFECTED_WORK">Cancel affected work — valid cancellation grounds</option>
          <option value="FURTHER_REVIEW">Further review — more evidence needed</option>
        </select>

        <label
          htmlFor={`reason-${milestoneId}`}
          className="block text-sm font-medium text-ink"
        >
          Reason (recorded immutably)
        </label>
        <textarea
          id={`reason-${milestoneId}`}
          name="reason"
          rows={3}
          required
          minLength={10}
          maxLength={2000}
          placeholder="Cite the agreement terms and evidence that justify this decision."
          className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
        />

        <label
          htmlFor={`evidence-${milestoneId}`}
          className="block text-sm font-medium text-ink"
        >
          Evidence references (optional, comma-separated)
        </label>
        <input
          id={`evidence-${milestoneId}`}
          name="evidenceRefs"
          type="text"
          placeholder="e.g. event ids, post URLs, correction notes"
          className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
        />

        <Button type="submit" variant="accent" disabled={isPending}>
          {isPending ? "Recording…" : "Record decision"}
        </Button>
      </form>

      {state && !state.success ? (
        <p className="text-sm text-danger" role="alert">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}
