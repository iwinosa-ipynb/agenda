"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import {
  toggleRateCardItemAction,
  updateRateCardItemAction,
} from "@/app/dashboard/_actions/rate-card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { FormError } from "@/components/ui/messages";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatMoney } from "@/lib/utils";
import type { ActionResult, RateCardItemSummary } from "@/types";

/**
 * One rate-card row. Active items show inline editing; inactive rows are
 * frozen history with a reactivate action. Status transitions go through the
 * server action — the client never decides an item's status.
 */
export function RateCardItemCard({ item }: { item: RateCardItemSummary }) {
  const [state, formAction, isPending] = useActionState<
    ActionResult | null,
    FormData
  >(toggleRateCardItemAction, null);
  const router = useRouter();

  useEffect(() => {
    if (state?.success) {
      router.refresh();
    }
  }, [state, router]);

  const isActive = item.status === "ACTIVE";

  return (
    <li className="py-4">
      {isActive ? (
        <ActiveItem item={item} />
      ) : (
        <InactiveItem item={item} />
      )}

      <form action={formAction} className="mt-2 flex items-center gap-3">
        <input type="hidden" name="itemId" value={item.id} />
        <Button
          variant={isActive ? "outline" : "primary"}
          size="sm"
          type="submit"
          disabled={isPending}
        >
          {isPending
            ? "Working…"
            : isActive
              ? "Deactivate"
              : "Reactivate"}
        </Button>
        {state && !state.success ? (
          <span className="text-xs text-danger" role="alert">
            {state.error}
          </span>
        ) : null}
      </form>
    </li>
  );
}

function ActiveItem({ item }: { item: RateCardItemSummary }) {
  const [editing, setEditing] = useState(false);
  const [state, formAction] = useActionState<ActionResult | null, FormData>(
    updateRateCardItemAction,
    null,
  );
  const router = useRouter();

  useEffect(() => {
    if (state?.success) {
      router.refresh();
    }
  }, [state, router]);

  const fieldErrors = state && !state.success ? (state.fieldErrors ?? {}) : {};

  // A successful save collapses back to the read-only display. Derived from
  // the action state — no setState-in-effect needed.
  const showForm = editing && !state?.success;

  if (!showForm) {
    return (
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium text-ink">
            {formatMoney(item.price, item.currency)}
            <span className="ml-2 text-xs font-normal text-ink-faint">
              v{item.version}
            </span>
          </p>
          <p className="text-sm text-ink-soft">
            {item.serviceType} · {item.platform}
          </p>
          {item.description ? (
            <p className="text-xs leading-relaxed text-ink-faint">
              {item.description}
            </p>
          ) : null}
        </div>
        {state?.success ? null : (
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
        )}
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="itemId" value={item.id} />

      <FormError message={state && !state.success ? state.error : null} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="New price"
          htmlFor={`price-${item.id}`}
          hint={`Current: ${formatMoney(item.price, item.currency)}. Your previous rate stays in your history.`}
          error={fieldErrors.price?.[0]}
        >
          <Input
            id={`price-${item.id}`}
            name="price"
            type="number"
            min={0.01}
            step="0.01"
            defaultValue={item.price}
            required
            invalid={Boolean(fieldErrors.price)}
          />
        </Field>

        <Field
          label="Description / notes"
          htmlFor={`description-${item.id}`}
          error={fieldErrors.description?.[0]}
        >
          <Input
            id={`description-${item.id}`}
            name="description"
            defaultValue={item.description ?? ""}
            placeholder="Optional note for advertisers"
          />
        </Field>
      </div>

      <div className="flex items-center gap-2">
        <SubmitButton size="sm" pendingLabel="Saving…">
          Save new version
        </SubmitButton>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={() => setEditing(false)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function InactiveItem({ item }: { item: RateCardItemSummary }) {
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium text-ink-faint line-through">
        {formatMoney(item.price, item.currency)}
      </p>
      <p className="text-sm text-ink-faint">
        {item.serviceType} · {item.platform} · v{item.version} · inactive
      </p>
    </div>
  );
}
