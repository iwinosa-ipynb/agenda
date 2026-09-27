"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";

import { transitionManagedBriefAction } from "@/app/dashboard/_actions/managed-brief-support";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/types";

/**
 * Support review controls for one managed brief (slice 2).
 *
 * The form carries only the brief id — the action refuses anyone but a
 * rostered SUPPORT session, and the next status is decided by the server's
 * state machine, never by a field here. One button per available transition;
 * a CLOSED brief renders nothing (it is terminal).
 */
export function ManagedBriefReviewControls({
  briefId,
  nextStatusLabel,
}: {
  briefId: string;
  nextStatusLabel: string | null;
}) {
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    transitionManagedBriefAction,
    null,
  );

  const router = useRouter();

  useEffect(() => {
    if (state?.success) {
      router.refresh();
    }
  }, [state, router]);

  if (!nextStatusLabel) {
    return (
      <p className="text-sm text-ink-soft">
        This brief is closed. No further status changes are possible.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <form action={formAction} className="flex items-center gap-3">
        <input type="hidden" name="briefId" value={briefId} />
        <Button type="submit" variant="accent" disabled={isPending}>
          {isPending ? "Updating…" : `Mark as ${nextStatusLabel}`}
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
