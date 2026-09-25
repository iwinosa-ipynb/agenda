"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";

import { submitMilestoneCorrectionAction, escalateMilestoneAction } from "@/app/dashboard/_actions/milestones";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/types";

/**
 * Creator controls while a correction is requested: submit the corrected
 * post (must already be submitted + verified through the normal post flow),
 * or escalate to support. Identity comes from the session; the milestone and
 * post are referenced by id only.
 */
export function CreatorMilestoneCorrectionControls({
  milestoneId,
  postId,
}: {
  milestoneId: string;
  /** The corrected post the creator is resubmitting (already submitted). */
  postId: string;
}) {
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    submitMilestoneCorrectionAction,
    null,
  );
  const [escalateState, escalateAction, escalatePending] = useActionState<
    ActionResult | null,
    FormData
  >(escalateMilestoneAction, null);

  const router = useRouter();

  useEffect(() => {
    if (state?.success || escalateState?.success) {
      router.refresh();
    }
  }, [state, escalateState, router]);

  const error =
    (!state?.success && state?.error) ||
    (!escalateState?.success && escalateState?.error) ||
    null;

  return (
    <div className="mt-5 space-y-4 border-t border-line pt-5">
      <form action={formAction}>
        <input type="hidden" name="milestoneId" value={milestoneId} />
        <input type="hidden" name="postId" value={postId} />
        <Button type="submit" variant="accent" disabled={isPending}>
          {isPending ? "Submitting…" : "Submit Correction"}
        </Button>
      </form>

      <form action={escalateAction}>
        <input type="hidden" name="milestoneId" value={milestoneId} />
        <input type="hidden" name="actorRole" value="CREATOR" />
        <input
          type="hidden"
          name="reason"
          value="Creator escalation: the correction request could not be resolved directly."
        />
        <Button type="submit" variant="outline" size="sm" disabled={escalatePending}>
          {escalatePending ? "Escalating…" : "Escalate to Support"}
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
