"use server";

import { revalidatePath } from "next/cache";

import { payoutBankNameForCode } from "@/lib/constants";
import { getViewerCreator } from "@/services/creator.service";
import {
  getPayoutRecipientSummary,
  savePayoutRecipient,
} from "@/services/payments/payout-recipient.service";
import { configurePaystackProviderIfConfigured } from "@/services/payments/paystack.provider";
import { savePayoutRecipientSchema } from "@/validation/payouts";
import type { ActionResult } from "@/types";

/**
 * Stage 14C — creator-only payout recipient actions.
 *
 * Identity ALWAYS comes from the server session (requireRole redirects any
 * other role before any code runs). The client may submit BANK DETAILS only —
 * a recipient code is never accepted from a client: codes are created
 * server-side via the provider port and stored server-side. The bank code is
 * resolved server-side against the provider's own verification (the adapter
 * refuses an account-name mismatch), so a wrong code simply fails safely.
 */

function actionError<T>(error: string): ActionResult<T> {
  return { success: false, error };
}

/** Safe confirmation data — never contains the raw account number or code. */
export type PayoutConfirmation = {
  accountName: string | null;
  bankName: string | null;
  currency: string;
  status: "ACTIVE";
  idempotentReplay: boolean;
};

export async function savePayoutRecipientAction(
  _prev: ActionResult<PayoutConfirmation> | null,
  formData: FormData,
): Promise<ActionResult<PayoutConfirmation>> {
  const { profile } = await getViewerCreator();

  const parsed = savePayoutRecipientSchema.safeParse({
    accountNumber: formData.get("accountNumber"),
    bankCode: formData.get("bankCode"),
    accountName: formData.get("accountName"),
    currency: formData.get("currency") ?? "NGN",
  });

  if (!parsed.success) {
    return actionError(
      parsed.error.issues[0]?.message ?? "Please check the bank details.",
    );
  }

  // Activate the provider when configured (no-op in dormant mode), mirroring
  // the Stage 14B payment-initiation action.
  configurePaystackProviderIfConfigured();

  const result = await savePayoutRecipient(profile.id, parsed.data);

  if (!result.ok) {
    return actionError(result.reason);
  }

  revalidatePath("/dashboard/payouts");
  revalidatePath("/dashboard/profile");

  const confirmation: PayoutConfirmation = {
    // From the service's stored (provider-verified) account name — never the
    // client-submitted string.
    accountName: result.accountName,
    bankName: payoutBankNameForCode(parsed.data.bankCode),
    currency: parsed.data.currency,
    status: "ACTIVE",
    idempotentReplay: result.idempotentReplay,
  };

  return { success: true, data: confirmation };
}

/** The creator's connected payout account, reduced to safe display fields. */
export type PayoutRecipientView = PayoutConfirmation & { connectedAt: string };

export async function getMyPayoutRecipientAction(): Promise<
  ActionResult<PayoutRecipientView>
> {
  const { profile } = await getViewerCreator();

  const summary = await getPayoutRecipientSummary(profile.id, "NGN");

  if (!summary) {
    return actionError<PayoutRecipientView>(
      "No payout account is connected yet.",
    );
  }

  return {
    success: true,
    data: {
      accountName: summary.accountName,
      bankName: null, // not stored server-side — nothing to echo
      currency: summary.currency,
      status: summary.status,
      connectedAt: summary.connectedAt.toISOString(),
      idempotentReplay: false,
    },
  };
}
