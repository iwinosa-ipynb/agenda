import "server-only";

import { prisma } from "@/lib/prisma";
import { getPaymentProvider } from "@/services/payments/index";
import type { SavePayoutRecipientInput } from "@/validation/payouts";

/**
 * Stage 14C — creator payout recipients (server-owned destinations).
 *
 * SECURITY MODEL:
 *   - identity comes from the creator session (the action passes the profile
 *     id resolved by getViewerCreator); a client can never act for another
 *     creator;
 *   - the CLIENT supplies bank details, never a recipient code — codes are
 *     created SERVER-SIDE through the provider port and stored here;
 *   - the provider resolves the account name for the account number and the
 *     adapter refuses a mismatch, so payouts can only ever target an account
 *     held in the creator's own (verified) name;
 *   - the raw account number is NOT persisted: only the provider's code and
 *     its verified account name are stored;
 *   - idempotency: a creator+provider+currency already has at most one ACTIVE
 *     recipient (unique constraint); saving again either returns the existing
 *     ACTIVE row or retires it and creates the replacement — history stays
 *     append-only.
 */

export type SaveRecipientResult =
  | {
      ok: true;
      recipientId: string;
      recipientCode: string;
      accountName: string | null;
      /** True when an existing ACTIVE recipient was returned unchanged. */
      idempotentReplay: boolean;
    }
  | { ok: false; code: "PROVIDER_UNCONFIGURED" | "RECIPIENT_FAILED"; reason: string };

export async function savePayoutRecipient(
  creatorProfileId: string,
  input: SavePayoutRecipientInput,
): Promise<SaveRecipientResult> {
  let provider;

  try {
    provider = getPaymentProvider();
  } catch {
    return {
      ok: false,
      code: "PROVIDER_UNCONFIGURED",
      reason: "No payment provider is configured yet.",
    };
  }

  // Idempotency pre-check: an unchanged ACTIVE recipient is reused as-is.
  const existingActive = await prisma.creatorPayoutRecipient.findUnique({
    where: {
      creatorId_provider_currency_status: {
        creatorId: creatorProfileId,
        provider: provider.name,
        currency: input.currency,
        status: "ACTIVE",
      },
    },
  });

  if (existingActive) {
    // Re-saving the SAME destination is a no-op (we cannot know whether the
    // code is still valid provider-side without a provider call; the status
    // poll at payout time is the validity check).
    return {
      ok: true,
      recipientId: existingActive.id,
      recipientCode: existingActive.recipientCode,
      accountName: existingActive.accountName,
      idempotentReplay: true,
    };
  }

  // Server-side recipient creation — the ONLY path a recipient code ever
  // enters the system. The adapter enforces the name match.
  const created = await provider.createRecipient({
    creatorId: creatorProfileId,
    currency: input.currency,
    bankAccount: {
      accountNumber: input.accountNumber,
      bankCode: input.bankCode,
      accountName: input.accountName,
    },
  });

  if (created.status !== "created") {
    return {
      ok: false,
      code: "RECIPIENT_FAILED",
      reason: created.reason,
    };
  }

  const recipient = await prisma.creatorPayoutRecipient.create({
    data: {
      creatorId: creatorProfileId,
      provider: provider.name,
      currency: input.currency,
      recipientCode: created.recipientCode,
      accountName: input.accountName,
      status: "ACTIVE",
    },
  });

  return {
    ok: true,
    recipientId: recipient.id,
    recipientCode: recipient.recipientCode,
    accountName: recipient.accountName,
    idempotentReplay: false,
  };
}

/**
 * The creator's ACTIVE payout recipient, or null. Used by the payout service
 * (the ONLY place a recipient code is ever read for a transfer) and by the
 * creator's own settings view.
 */
export async function getActiveRecipientForCreator(
  creatorProfileId: string,
  currency: string,
) {
  return prisma.creatorPayoutRecipient.findFirst({
    where: {
      creatorId: creatorProfileId,
      currency,
      status: "ACTIVE",
    },
    orderBy: { createdAt: "desc" },
  });
}
