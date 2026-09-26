"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";

import { initiatePaymentAction } from "@/app/dashboard/_actions/payments";
import { Button } from "@/components/ui/button";
import { formatMajor } from "@/lib/money";
import type { ActionResult } from "@/types";

/**
 * Stage 14B — advertiser "Fund now" form (Paystack hosted page).
 *
 * The only value submitted is the obligation id. The exact charge amount is
 * displayed from the server-frozen obligation (advertiserTotal = creator
 * amount + platform fee) — the client can never alter it. On success the
 * browser is redirected to Paystack's hosted payment page; the payment is
 * NOT complete until server-side verification confirms the real funds.
 */
export function PaymentInitiationForm({
  obligationId,
  creatorAmountMinor,
  platformFeeMinor,
  advertiserTotalMinor,
  currency,
}: {
  obligationId: string;
  creatorAmountMinor: bigint;
  platformFeeMinor: bigint;
  advertiserTotalMinor: bigint;
  currency: string;
}) {
  const [state, formAction, isPending] = useActionState<
    ActionResult<{ redirectUrl: string }> | null,
    FormData
  >(initiatePaymentAction, null);

  const router = useRouter();

  useEffect(() => {
    if (state?.success && state.data.redirectUrl) {
      // Paystack hosted page. Verification — not the redirect — completes
      // the payment; the agreements page reflects the verified state.
      window.location.assign(state.data.redirectUrl);
    }
  }, [state, router]);

  return (
    <form action={formAction} className="mt-4 space-y-3 border-t border-line pt-4">
      <input type="hidden" name="obligationId" value={obligationId} />

      <div className="rounded-lg border border-line bg-surface-muted px-3.5 py-3 text-xs leading-relaxed text-ink-soft">
        <p>
          <span className="font-medium text-ink">Creator amount:</span>{" "}
          {formatMajor(creatorAmountMinor, currency)} {currency}{" "}
          <span className="font-medium text-ink">· Platform service fee:</span>{" "}
          {formatMajor(platformFeeMinor, currency)} {currency}
        </p>
        <p className="mt-1">
          <span className="font-medium text-ink">You pay:</span>{" "}
          {formatMajor(advertiserTotalMinor, currency)} {currency} — collected
          through Paystack&apos;s secure checkout. Milestones unlock only after
          the payment is verified server-side.
        </p>
      </div>

      <Button type="submit" variant="accent" size="sm" disabled={isPending}>
        {isPending ? "Opening Paystack…" : "Fund now via Paystack"}
      </Button>

      {state && !state.success ? (
        <p className="text-sm text-danger" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
