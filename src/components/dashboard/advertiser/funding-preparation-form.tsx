"use client";

import { useActionState, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { prepareFundingAction } from "@/app/dashboard/_actions/funding";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/utils";
import type { ActionResult } from "@/types";

/**
 * Stage 14A — advertiser "Prepare funding" form.
 *
 * Shows the EXACT frozen agreement amount before confirmation and lets the
 * advertiser define explicit milestone terms (positions/titles/amounts) that
 * must reconcile EXACTLY to that amount. The server re-validates everything
 * in BigInt minor units; this live preview exists so the advertiser sees the
 * breakdown before submitting.
 *
 * NOTHING here implies money has been paid: preparation only creates the
 * obligation (awaiting payment) and the milestones. Payment status stays
 * "Awaiting payment" until a Stage 14B provider VERIFIES real funds.
 */
export function FundingPreparationForm({
  agreementId,
  agreedAmount,
  currency,
}: {
  agreementId: string;
  /** Frozen agreement amount, formatted for display. */
  agreedAmount: string;
  currency: string;
}) {
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    prepareFundingAction,
    null,
  );

  const router = useRouter();

  const [milestoneCount, setMilestoneCount] = useState(1);
  // Controlled amounts keep the live reconciliation preview exact — the
  // authoritative reconciliation still happens server-side in minor units.
  const [amounts, setAmounts] = useState<Record<number, string>>({});

  const handleAmountChange = (position: number, value: string) => {
    // Keep only plain decimals; the schema enforces the exact format.
    setAmounts((previous) => ({
      ...previous,
      [position]: value.replace(/[^\d.]/g, ""),
    }));
  };

  const updateMilestoneCount = (nextCount: number) => {
    const clamped = Math.max(1, Math.min(52, nextCount));

    setMilestoneCount(clamped);
    setAmounts((previous) => {
      const next: Record<number, string> = {};

      for (let position = 1; position <= clamped; position += 1) {
        next[position] = previous[position] ?? "";
      }

      return next;
    });
  };

  // Live reconciliation preview in whole-units display terms only — the
  // authoritative reconciliation is BigInt minor units on the server.
  const enteredTotal = useMemo(() => {
    let sum = 0;

    for (let position = 1; position <= milestoneCount; position += 1) {
      const value = Number(amounts[position] ?? "0");

      if (Number.isFinite(value) && value > 0) {
        sum += value;
      }
    }

    return sum;
  }, [milestoneCount, amounts]);

  const agreementTotal = Number(agreedAmount);
  const reconciles = enteredTotal === agreementTotal && enteredTotal > 0;

  return (
    <form action={formAction} className="mt-4 space-y-4 border-t border-line pt-4">
      <input type="hidden" name="agreementId" value={agreementId} />
      <input type="hidden" name="milestoneCount" value={milestoneCount} />

      <div className="rounded-lg border border-line bg-surface-muted px-3.5 py-3 text-xs leading-relaxed text-ink-soft">
        <p>
          <span className="font-medium text-ink">Funding amount (frozen):</span>{" "}
          {formatMoney(agreedAmount, currency)}
        </p>
        <p className="mt-1">
          Define the milestones this agreement pays out in. The milestone
          amounts must add up to exactly the frozen amount. Preparing funding
          does NOT take a payment — the obligation stays “Awaiting payment”
          until the payment provider verifies real funds.
        </p>
      </div>

      <div className="space-y-3">
        {Array.from({ length: milestoneCount }, (_, index) => index + 1).map(
          (position) => (
            <fieldset
              key={position}
              className="rounded-lg border border-line px-3 py-3"
            >
              <legend className="px-1 text-xs font-medium text-ink-soft">
                Milestone {position}
              </legend>

              <div className="grid gap-2 sm:grid-cols-[1fr_180px]">
                <label className="block text-xs text-ink-soft">
                  Title (optional)
                  <input
                    name={`title_${position}`}
                    type="text"
                    maxLength={200}
                    placeholder="e.g. Launch video"
                    className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
                  />
                </label>

                <label className="block text-xs text-ink-soft">
                  Creator amount ({currency})
                  <input
                    name={`amount_${position}`}
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    required
                    value={amounts[position] ?? ""}
                    onChange={(event) =>
                      handleAmountChange(position, event.target.value)
                    }
                    placeholder="0.00"
                    className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
                  />
                </label>
              </div>

              <label className="mt-2 block text-xs text-ink-soft">
                Deliverables (optional)
                <input
                  name={`deliverables_${position}`}
                  type="text"
                  maxLength={4000}
                  placeholder="What must be delivered for this milestone"
                  className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
                />
              </label>
            </fieldset>
          ),
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isPending || milestoneCount >= 52}
            onClick={() => updateMilestoneCount(milestoneCount + 1)}
          >
            + Add milestone
          </Button>
          {milestoneCount > 1 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isPending}
              onClick={() => updateMilestoneCount(milestoneCount - 1)}
            >
              − Remove
            </Button>
          ) : null}
        </div>

        <p
          className={
            reconciles
              ? "text-xs text-accent-strong"
              : "text-xs text-ink-soft"
          }
          aria-live="polite"
        >
          Milestones total {formatMoney(enteredTotal.toFixed(2), currency)} of{" "}
          {formatMoney(agreedAmount, currency)}
          {enteredTotal === 0
            ? " — enter each milestone's amount"
            : reconciles
              ? " — reconciles exactly"
              : enteredTotal < agreementTotal
                ? " — under-allocated"
                : " — exceeds the frozen amount"}
        </p>
      </div>

      <Button
        type="submit"
        variant="accent"
        size="sm"
        disabled={isPending || (enteredTotal > 0 && !reconciles)}
      >
        {isPending ? "Preparing…" : "Prepare funding"}
      </Button>

      <p className="text-xs leading-relaxed text-ink-soft">
        No payment is taken by this step. After preparation, fund this
        agreement through the payment provider to unlock milestone delivery.
      </p>

      {state && !state.success ? (
        <p className="text-sm text-danger" role="alert">
          {state.error}
        </p>
      ) : null}
      {state?.success ? (
        <p className="text-sm text-accent-strong" role="status">
          Funding prepared — the milestones are defined and the obligation is
          awaiting payment. Complete funding through the payment provider.
        </p>
      ) : null}
    </form>
  );
}
