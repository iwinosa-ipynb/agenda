"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { executeFullRefundAction } from "@/app/dashboard/_actions/support-financial";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/types";

type RefundOutcome = { status: string; outcome: string };
type RefundActionState = ActionResult<RefundOutcome> | null;

/**
 * Support trigger for a FULL refund of one funded obligation.
 *
 * No amount, provider reference or status is ever accepted from the client —
 * the refund amount is the frozen advertiser total derived server-side by the
 * 14E service, and eligibility is derived server-side too (the page renders
 * this control only for FUNDED / SETTLEMENT_PENDING / REFUND_PENDING). The
 * result is reported honestly: completed (REFUNDED) vs pending
 * (REFUND_PENDING — submitted, awaiting the provider) vs refused, with a safe
 * operator-facing reason.
 */
export function ObligationRefundControl({ obligationId }: { obligationId: string }) {
  const [state, formAction, isPending] = useActionState<RefundActionState, FormData>(
    executeFullRefundAction,
    null,
  );

  const router = useRouter();
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (state?.success) {
      router.refresh();
      setConfirming(false);
    }
  }, [state, router]);

  const data = state?.success ? (state.data as RefundOutcome) : null;
  const submitted = data !== null; // one completed submission: no resubmission until state changes

  return (
    <div className="mt-3 space-y-3">
      <p className="text-sm text-ink-soft">
        Issues a FULL refund to the advertiser — exactly the frozen advertiser
        total, verified server-side against the provider. Partial refunds do
        not exist. The provider is the only authority: if it cannot yet confirm
        the outcome, the obligation stays in REFUND_PENDING and reconciliation
        converges it.
      </p>

      {!confirming && !submitted ? (
        <Button
          type="button"
          variant="outline"
          disabled={isPending}
          onClick={() => setConfirming(true)}
        >
          {isPending ? "Submitting…" : "Issue full refund…"}
        </Button>
      ) : null}

      {confirming && !submitted ? (
        <form action={formAction} className="space-y-3 rounded-lg border border-line p-4">
          <input type="hidden" name="obligationId" value={obligationId} />

          <p className="text-sm font-medium text-ink">
            Refund the FULL advertiser total for this obligation?
          </p>
          <p className="text-xs leading-relaxed text-ink-faint">
            The refund cannot be undone once the provider processes it. Any
            settled or in-flight creator payout blocks the refund (enforced by
            the service).
          </p>

          <div className="flex gap-2">
            <Button type="submit" variant="accent" disabled={isPending}>
              {isPending ? "Submitting…" : "Confirm full refund"}
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
      ) : null}

      {data ? (
        <p
          className={
            data.status === "REFUNDED"
              ? "text-sm font-medium text-ink"
              : "text-sm text-ink-soft"
          }
          role="status"
        >
          {data.outcome}
        </p>
      ) : null}

      {state && !state.success ? (
        <p className="text-sm text-danger" role="alert">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}
