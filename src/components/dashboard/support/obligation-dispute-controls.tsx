"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { setDisputeFreezeAction } from "@/app/dashboard/_actions/support-financial";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/types";

/**
 * Support controls for the dispute-freeze overlay on one obligation.
 *
 * The freeze state shown here is derived SERVER-SIDE (the `frozen` prop comes
 * from the page's funding read, never from client state) and the action is
 * the audited, roster-gated Support seam. No financial value is accepted or
 * calculated here — only the obligation id (hidden field) and an optional
 * secret-free operational reason.
 *
 * DISPUTED is a flag overlay, not an obligation status: freezing never moves
 * money state on its own, it only blocks RELEASED/REFUNDED transitions in the
 * state machine while engaged.
 */
export function ObligationDisputeControls({
  obligationId,
  frozen,
}: {
  obligationId: string;
  frozen: boolean;
}) {
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    setDisputeFreezeAction,
    null,
  );

  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [confirmedReason, setConfirmedReason] = useState("");

  useEffect(() => {
    if (state?.success) {
      router.refresh();
      setConfirming(false);
      setConfirmedReason("");
    }
  }, [state, router]);

  return (
    <div className="mt-3 space-y-3">
      <p className="text-sm text-ink-soft">
        {frozen
          ? "A dispute freeze is ENGAGED: the state machine refuses every release and refund while the freeze is in force. Lift it explicitly to let money move."
          : "No dispute freeze. Engaging one blocks all release and refund transitions until it is explicitly lifted — the obligation status itself is not changed."}
      </p>

      {!confirming ? (
        <Button
          type="button"
          variant={frozen ? "primary" : "outline"}
          disabled={isPending}
          onClick={() => setConfirming(true)}
        >
          {isPending ? "Updating…" : frozen ? "Lift dispute freeze…" : "Engage dispute freeze…"}
        </Button>
      ) : (
        <form action={formAction} className="space-y-3 rounded-lg border border-line p-4">
          <input type="hidden" name="obligationId" value={obligationId} />
          <input type="hidden" name="freeze" value={frozen ? "false" : "true"} />

          <p className="text-sm font-medium text-ink">
            {frozen
              ? "Lift the dispute freeze on this obligation?"
              : "Engage a dispute freeze on this obligation?"}
          </p>

          <label
            htmlFor={`freeze-reason-${obligationId}`}
            className="block text-sm font-medium text-ink"
          >
            Reason (optional, recorded immutably in the financial audit)
          </label>
          <textarea
            id={`freeze-reason-${obligationId}`}
            name="reason"
            rows={2}
            maxLength={500}
            value={confirmedReason}
            onChange={(event) => setConfirmedReason(event.target.value)}
            placeholder="Short, secret-free operational note."
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
          />

          <div className="flex gap-2">
            <Button type="submit" variant="accent" disabled={isPending}>
              {isPending ? "Updating…" : "Confirm"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={isPending}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </div>
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
