"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";

import { addManagedBriefCandidateAction } from "@/app/dashboard/_actions/managed-brief-candidates";
import { Button } from "@/components/ui/button";
import { Field, Label, Select, Textarea } from "@/components/ui/field";
import { PLATFORM_LABELS } from "@/lib/constants";
import type {
  ManagedBriefCandidateAccountOption,
  ActionResult,
} from "@/types";

/**
 * Support-only form for adding a sourcing candidate to a managed brief
 * (slice 3). The picker lists EXISTING creator accounts (reference, never a
 * typed-in identity); the internal note is optional. The action refuses
 * anyone but a rostered SUPPORT session, and the form carries no field that
 * can influence identity or permission.
 *
 * The select encodes both ids as "<socialAccountId>:<creatorProfileId>": the
 * service re-verifies that the account belongs to that creator, so a forged
 * or mismatched pair is rejected server-side regardless of what the client
 * sends.
 */
export function ManagedBriefCandidateAddForm({
  briefId,
  accountOptions,
}: {
  briefId: string;
  accountOptions: ManagedBriefCandidateAccountOption[];
}) {
  const [state, formAction, isPending] = useActionState<
    ActionResult | null,
    FormData
  >(addManagedBriefCandidateAction, null);
  const router = useRouter();

  useEffect(() => {
    if (state?.success) {
      router.refresh();
    }
  }, [state, router]);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="briefId" value={briefId} />

      <Field
        label="Creator account"
        htmlFor="candidate-account-option"
        hint="Existing creator accounts only — identity data is referenced, not duplicated."
      >
        <Select
          id="candidate-account-option"
          name="creatorAccountOption"
          defaultValue=""
          disabled={isPending || accountOptions.length === 0}
        >
          <option value="" disabled>
            {accountOptions.length === 0
              ? "No creator accounts exist yet"
              : "Select a creator account…"}
          </option>
          {accountOptions.map((option) => (
            <option key={option.accountId} value={option.accountId}>
              {option.creatorName} (@{option.username}) —{" "}
              {PLATFORM_LABELS[option.platform]}: @{option.accountUsername}
            </option>
          ))}
        </Select>
      </Field>

      <div className="space-y-1.5">
        <Label htmlFor="candidate-note">Internal note (optional)</Label>
        <Textarea
          id="candidate-note"
          name="note"
          rows={3}
          maxLength={1000}
          disabled={isPending}
          placeholder="Why this creator fits the brief — support-eyes only."
        />
        <p className="text-xs text-ink-faint">
          Visible to Agenda support only — advertisers never see notes.
        </p>
      </div>

      {state && !state.success ? (
        <p className="text-sm text-danger" role="alert">
          {state.error}
        </p>
      ) : null}

      <Button
        type="submit"
        variant="accent"
        size="sm"
        disabled={isPending || accountOptions.length === 0}
      >
        {isPending ? "Adding…" : "Add candidate"}
      </Button>
    </form>
  );
}
