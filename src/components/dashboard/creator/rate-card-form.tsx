"use client";

import { useActionState, useEffect, useRef } from "react";

import { createRateCardItemAction } from "@/app/dashboard/_actions/rate-card";
import { Field, Input, Select } from "@/components/ui/field";
import { FormError, FormSuccess } from "@/components/ui/messages";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  CAMPAIGN_PLATFORMS,
  PLATFORM_LABELS,
  RATE_CARD_SERVICE_TYPES,
  RATE_CARD_SERVICE_TYPE_LABELS,
} from "@/lib/constants";
import type { ActionResult } from "@/types";

/**
 * Add-rate form. Currency is intentionally absent: campaigns are priced in
 * NGN at this stage, and the server pins NGN rather than trusting the client.
 */
export function RateCardForm() {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(
    createRateCardItemAction,
    null,
  );
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.success) {
      formRef.current?.reset();
    }
  }, [state]);

  const fieldErrors = state && !state.success ? (state.fieldErrors ?? {}) : {};

  return (
    <form ref={formRef} action={formAction} className="space-y-5" noValidate>
      <FormError message={state && !state.success ? state.error : null} />
      <FormSuccess
        message={state?.success ? "Rate added to your card." : null}
      />

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="Platform"
          htmlFor="rate-card-platform"
          error={fieldErrors.platform?.[0]}
        >
          <Select
            id="rate-card-platform"
            name="platform"
            defaultValue={CAMPAIGN_PLATFORMS[0]}
            invalid={Boolean(fieldErrors.platform)}
          >
            {CAMPAIGN_PLATFORMS.map((platform) => (
              <option key={platform} value={platform}>
                {PLATFORM_LABELS[platform]}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Content type"
          htmlFor="rate-card-service-type"
          error={fieldErrors.serviceType?.[0]}
        >
          <Select
            id="rate-card-service-type"
            name="serviceType"
            defaultValue={RATE_CARD_SERVICE_TYPES[0]}
            invalid={Boolean(fieldErrors.serviceType)}
          >
            {RATE_CARD_SERVICE_TYPES.map((serviceType) => (
              <option key={serviceType} value={serviceType}>
                {RATE_CARD_SERVICE_TYPE_LABELS[serviceType]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field
        label="Price"
        htmlFor="rate-card-price"
        hint="Your listed starting rate in NGN. Advertisers see this as a reference — your final price is whatever you quote per campaign."
        error={fieldErrors.price?.[0]}
      >
        <Input
          id="rate-card-price"
          name="price"
          type="number"
          min={0.01}
          step="0.01"
          placeholder="150000"
          required
          invalid={Boolean(fieldErrors.price)}
        />
      </Field>

      <Field
        label="Description / notes"
        htmlFor="rate-card-description"
        hint="Optional, up to 500 characters."
        error={fieldErrors.description?.[0]}
      >
        <Input
          id="rate-card-description"
          name="description"
          placeholder="e.g. Includes one round of revisions"
        />
      </Field>

      <SubmitButton pendingLabel="Adding…">Add rate</SubmitButton>
    </form>
  );
}
