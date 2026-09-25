"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";

import {
  confirmMilestoneReleaseAction,
  requestMilestoneCorrectionAction,
  escalateMilestoneAction,
} from "@/app/dashboard/_actions/milestones";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/types";

/**
 * Stage 13B advertiser controls for a VERIFIED_PENDING_REVIEW milestone:
 * primary "Confirm & Release Payment", secondary "Request Correction" (with
 * a required note), and tertiary "Escalate to Support". Identity always comes
 * from the session; no amount field exists anywhere.
 */
export function AdvertiserMilestoneControls({
  milestoneId,
}: {
  milestoneId: string;
}) {
  const [confirmState, confirmAction, confirmPending] = useActionState<
    ActionResult | null,
    FormData
  >(confirmMilestoneReleaseAction, null);
  const [correctState, correctAction, correctPending] = useActionState<
    ActionResult | null,
    FormData
  >(requestMilestoneCorrectionAction, null);
  const [escalateState, escalateAction, escalatePending] = useActionState<
    ActionResult | null,
    FormData
  >(escalateMilestoneAction, null);

  const router = useRouter();

  useEffect(() => {
    if (
      (confirmState?.success || correctState?.success || escalateState?.success) === true
    ) {
      router.refresh();
    }
  }, [confirmState, correctState, escalateState, router]);

  const error =
    (!confirmState?.success && confirmState?.error) ||
    (!correctState?.success && correctState?.error) ||
    (!escalateState?.success && escalateState?.error) ||
    null;

  return (
    <div className="mt-5 space-y-4 border-t border-line pt-5">
      <div className="flex flex-wrap items-center gap-3">
        <form action={confirmAction}>
          <input type="hidden" name="milestoneId" value={milestoneId} />
          <Button type="submit" variant="accent" disabled={confirmPending}>
            {confirmPending ? "Confirming…" : "Confirm & Release Payment"}
          </Button>
        </form>

        <form action={escalateAction}>
          <input type="hidden" name="milestoneId" value={milestoneId} />
          <input type="hidden" name="actorRole" value="ADVERTISER" />
          <Button type="submit" variant="outline" disabled={escalatePending}>
            {escalatePending ? "Escalating…" : "Escalate to Support"}
          </Button>
        </form>
      </div>

      <form action={correctAction} className="space-y-2">
        <input type="hidden" name="milestoneId" value={milestoneId} />
        <label
          htmlFor={`correction-${milestoneId}`}
          className="block text-sm font-medium text-ink"
        >
          Request Correction
        </label>
        <textarea
          id={`correction-${milestoneId}`}
          name="note"
          rows={3}
          required
          minLength={10}
          maxLength={2000}
          placeholder="Describe exactly what needs fixing — e.g. a missing required hashtag, wrong caption, missing mention, or a missing deliverable."
          className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
        />
        <Button type="submit" variant="outline" size="sm" disabled={correctPending}>
          {correctPending ? "Sending…" : "Send correction request"}
        </Button>
      </form>

      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
