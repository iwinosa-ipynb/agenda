import type { Metadata } from "next";

import {
  ConnectedRecipientConfirmation,
  PayoutBankDetailsForm,
} from "@/components/dashboard/creator/payout-bank-details-form";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card } from "@/components/ui/card";
import { getViewerCreator } from "@/services/creator.service";
import { getPayoutRecipientSummary } from "@/services/payments/payout-recipient.service";

export const metadata: Metadata = {
  title: "Payout account",
};

/**
 * Stage 14C — creator-only payout bank details (inside the (creator) route
 * group, whose layout enforces the CREATOR role server-side on every
 * request). Identity is resolved from the session — never from client input.
 *
 * Only safe details are rendered: the provider-verified account name and the
 * payout status. The raw account number is not persisted anywhere and is
 * never echoed back.
 */
export default async function PayoutsPage() {
  const { profile } = await getViewerCreator();

  const summary = await getPayoutRecipientSummary(profile.id, "NGN");

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8">
      <PageHeader
        title="Payout account"
        description="Where your milestone payouts are sent. Agenda verifies the account name with your bank before connecting it."
      />

      <Card className="p-6 sm:p-8">
        <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
          {summary ? "Connected payout account" : "Connect your payout account"}
        </h2>
        <p className="mt-1 text-sm text-ink-soft">
          {summary
            ? "This is the destination used for your milestone payouts."
            : "Add the bank account that should receive your milestone payouts."}
        </p>

        {summary ? (
          <div className="mt-6 space-y-4">
            <ConnectedRecipientConfirmation
              accountName={summary.accountName}
              bankName={null}
              currency={summary.currency}
              status={summary.status}
            />
            <p className="text-xs leading-relaxed text-ink-faint">
              Connected{" "}
              {summary.connectedAt.toLocaleDateString("en-NG", {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}.
            </p>
            <div className="border-t border-line pt-6">
              <h3 className="text-sm font-semibold tracking-[-0.01em] text-ink">
                Re-confirm your payout account
              </h3>
              <p className="mt-1 text-sm text-ink-soft">
                While your account stays connected, resubmitting is a safe
                re-confirmation — destinations are only swapped through the
                secure verification flow with your bank.
              </p>
              <div className="mt-4">
                <PayoutBankDetailsForm hasExistingRecipient />
              </div>
            </div>
            <p className="text-xs leading-relaxed text-ink-faint">
              Recipient codes are managed by Agenda on the server — you never
              need to enter or see one.
            </p>
          </div>
        ) : (
          <div className="mt-6">
            <PayoutBankDetailsForm hasExistingRecipient={false} />
          </div>
        )}
      </Card>
    </div>
  );
}
