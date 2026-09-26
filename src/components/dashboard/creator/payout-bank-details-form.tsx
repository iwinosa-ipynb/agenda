"use client";

import { useActionState } from "react";

import {
  savePayoutRecipientAction,
  type PayoutConfirmation,
} from "@/app/dashboard/_actions/payouts";
import { Field, Input, Select } from "@/components/ui/field";
import { FormError, FormSuccess } from "@/components/ui/messages";
import { SubmitButton } from "@/components/ui/submit-button";
import { PAYOUT_NGN_BANKS } from "@/lib/constants";
import type { ActionResult } from "@/types";

/**
 * Stage 14C — creator bank-details form.
 *
 * The ONLY values submitted are the bank details themselves. No creator id
 * and no recipient code is ever sent: identity is resolved server-side from
 * the session, and recipient codes are created server-side. On success the
 * form shows only safe confirmation data (verified account name, bank name,
 * payout status) — the raw account number is never echoed back.
 */
export function PayoutBankDetailsForm({
  hasExistingRecipient,
}: {
  hasExistingRecipient: boolean;
}) {
  const [state, formAction] = useActionState<
    ActionResult<PayoutConfirmation> | null,
    FormData
  >(savePayoutRecipientAction, null);

  const confirmation = state?.success ? state.data : null;

  return (
    <div className="space-y-5">
      <FormError message={state && !state.success ? state.error : null} />

      {confirmation ? (
        <FormSuccess
          message={
            confirmation.idempotentReplay
              ? "This payout account is already connected — nothing changed."
              : "Payout account connected. Future milestone payouts go to this account."
          }
        />
      ) : null}

      {confirmation ? (
        <ConnectedRecipientConfirmation
          accountName={confirmation.accountName}
          bankName={confirmation.bankName}
          currency={confirmation.currency}
          status={confirmation.status}
        />
      ) : (
        <form action={formAction} className="space-y-5" noValidate>
          {hasExistingRecipient ? (
            <p className="rounded-lg border border-line bg-surface-muted px-3.5 py-3 text-xs leading-relaxed text-ink-soft">
              A payout account is already connected. While it stays connected,
              resubmitting here is a safe re-confirmation — Agenda never swaps
              destinations automatically. To change the destination, contact
              support; the bank verifies the account name either way.
            </p>
          ) : null}

          <Field
            label="Bank"
            htmlFor="bankCode"
            hint="Where your payouts will be sent."
          >
            <Select id="bankCode" name="bankCode" required defaultValue="">
              <option value="" disabled>
                Select your bank…
              </option>
              {PAYOUT_NGN_BANKS.map((bank) => (
                <option key={bank.code} value={bank.code}>
                  {bank.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Account number"
            htmlFor="accountNumber"
            hint="10 digits. Agenda never stores it — only your bank confirms it."
          >
            <Input
              id="accountNumber"
              name="accountNumber"
              inputMode="numeric"
              autoComplete="off"
              maxLength={10}
              placeholder="0123456789"
              required
            />
          </Field>

          <Field
            label="Account name"
            htmlFor="accountName"
            hint="Exactly as your bank registered it — we verify this with your bank."
          >
            <Input
              id="accountName"
              name="accountName"
              autoComplete="off"
              placeholder="As it appears on your bank record"
              required
            />
          </Field>

          <SubmitButton pendingLabel="Verifying with your bank…">
            {hasExistingRecipient
              ? "Re-confirm payout account"
              : "Connect payout account"}
          </SubmitButton>
        </form>
      )}
    </div>
  );
}

/**
 * Safe confirmation panel: verified account name, bank name and payout
 * status only. The raw account number is intentionally absent.
 */
export function ConnectedRecipientConfirmation({
  accountName,
  bankName,
  currency,
  status,
}: {
  accountName: string | null;
  bankName: string | null;
  currency: string;
  status: string;
}) {
  return (
    <dl className="rounded-lg border border-line bg-surface-muted px-4 py-4 text-sm">
      <div className="flex justify-between gap-4 py-1">
        <dt className="text-ink-soft">Account name</dt>
        <dd className="font-medium text-ink">{accountName ?? "—"}</dd>
      </div>
      <div className="flex justify-between gap-4 py-1">
        <dt className="text-ink-soft">Bank</dt>
        <dd className="font-medium text-ink">{bankName ?? "—"}</dd>
      </div>
      <div className="flex justify-between gap-4 py-1">
        <dt className="text-ink-soft">Currency</dt>
        <dd className="font-medium text-ink">{currency}</dd>
      </div>
      <div className="flex justify-between gap-4 py-1">
        <dt className="text-ink-soft">Payout status</dt>
        <dd className="font-medium text-ink">{status}</dd>
      </div>
    </dl>
  );
}
