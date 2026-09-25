"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { applyToCampaignAction } from "@/app/dashboard/_actions/applications";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { FormError } from "@/components/ui/messages";
import type { ActionResult } from "@/types";

export type ApplyGuidance = {
  dataAvailability: "AVAILABLE" | "INSUFFICIENT_DATA";
  explanation: string;
  suggestedMin: string | null;
  suggestedMax: string | null;
} | null;

/**
 * Quote preview exactly as the advertiser will see it — always visible before
 * submitting (brief §10: "Your requested fee: ₦X").
 */
function QuotePreview({
  amount,
  currency,
}: {
  amount: string;
  currency: string;
}) {
  const numeric = Number(amount);

  if (!amount || !Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  const formatted = new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(numeric);

  return (
    <p className="rounded-lg border border-accent/25 bg-accent-soft px-3.5 py-3 text-sm text-accent-strong">
      <span className="font-medium">Your requested fee:</span> {formatted}
    </p>
  );
}

export function ApplyToCampaign({
  campaignId,
  currency,
  closed,
  guidance,
}: {
  campaignId: string;
  /** Campaign currency — quotes must match it, enforced server-side. */
  currency: string;
  closed: boolean;
  guidance: ApplyGuidance;
}) {
  const [state, formAction, isPending] = useActionState<
    ActionResult | null,
    FormData
  >(applyToCampaignAction, null);
  const [quote, setQuote] = useState("");
  const router = useRouter();

  useEffect(() => {
    if (state?.success) {
      router.refresh();
    }
  }, [state, router]);

  if (state?.success) {
    return (
      <p className="rounded-lg border border-accent/25 bg-accent-soft px-3.5 py-3 text-sm text-accent-strong">
        Application submitted. The advertiser will review your quote and
        proposal. You can track it under My applications.
      </p>
    );
  }

  if (closed) {
    return (
      <p className="rounded-lg border border-line bg-surface-muted px-3.5 py-3 text-sm text-ink-soft">
        This campaign is no longer accepting applications.
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="campaignId" value={campaignId} />
      <input type="hidden" name="currency" value={currency} />

      <Field
        label="Your requested fee"
        htmlFor="quoteAmount"
        hint={`In ${currency}. You set your own price — the advertiser accepts it or not.`}
        error={state && !state.success ? state.fieldErrors?.quoteAmount?.[0] : undefined}
      >
        <Input
          id="quoteAmount"
          name="quoteAmount"
          type="number"
          min={0.01}
          step="0.01"
          placeholder="150000"
          required
          value={quote}
          onChange={(event) => setQuote(event.target.value)}
          invalid={Boolean(state && !state.success && state.fieldErrors?.quoteAmount)}
        />
      </Field>

      {guidance ? (
        <p className="rounded-lg border border-line bg-surface-muted px-3.5 py-3 text-xs leading-relaxed text-ink-soft">
          {guidance.dataAvailability === "AVAILABLE" ? (
            <>
              <span className="font-medium text-ink">
                Suggested range:{" "}
                {`${guidance.suggestedMin}–${guidance.suggestedMax} ${currency}`}
              </span>{" "}
              — {guidance.explanation}
            </>
          ) : (
            guidance.explanation
          )}
        </p>
      ) : null}

      <Field
        label="Message to the advertiser"
        htmlFor="application-message"
        hint="Optional, up to 500 characters."
      >
        <Textarea
          id="application-message"
          name="message"
          maxLength={500}
          placeholder="A short note about why you're a good fit."
        />
      </Field>

      <QuotePreview amount={quote} currency={currency} />

      <FormError message={state && !state.success ? state.error : null} />

      <Button
        type="submit"
        variant="accent"
        size="lg"
        className="w-full"
        disabled={isPending}
      >
        {isPending ? "Submitting…" : "Submit application"}
      </Button>
    </form>
  );
}
