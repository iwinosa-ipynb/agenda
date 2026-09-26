import "server-only";

import type { Prisma } from "@/generated/prisma/client";

import { isUniqueConstraintError } from "@/lib/prisma-errors";
import { prisma } from "@/lib/prisma";
import { toMinorUnits } from "@/lib/money";
import { computeObligationAmounts } from "@/services/payments/fee-engine";
import { getActiveFeeConfiguration } from "@/services/payments/fee-config.service";

/**
 * Stage 13A — financial obligation creation.
 *
 * Derives a FinancialObligation 1:1 from a Stage 12 CampaignAgreement:
 *
 *   Rate Card → Campaign Quote → Accepted Quote → Agreement → Obligation
 *
 * The obligation reads ONLY the frozen agreement columns. The creator's rate
 * card and the campaign budget are never consulted, and no client input can
 * supply or override any amount:
 *
 *   - creatorAmountMinor = toMinorUnits(agreement.agreedAmount) — the single
 *     Decimal → minor-unit conversion boundary;
 *   - platformFeeMinor   = server-side fee configuration (FEE_NOT_CONFIGURED
 *     refuses creation rather than inventing a fee);
 *   - advertiserTotalMinor = creatorAmountMinor + platformFeeMinor.
 *
 * Idempotent: one obligation per agreement, enforced by the database
 * (unique agreementId). Concurrent creations lose the unique race and are
 * served the existing row — no in-memory locking anywhere.
 */

export type ObligationCreationResult =
  | {
      ok: true;
      obligationId: string;
      obligationRef: string;
      /** True when an obligation already existed for this agreement. */
      alreadyExisted: boolean;
      creatorAmountMinor: bigint;
      platformFeeMinor: bigint;
      advertiserTotalMinor: bigint;
      currency: string;
    }
  | { ok: false; code: "AGREEMENT_NOT_FOUND" | "FEE_NOT_CONFIGURED" | "INVALID_AGREEMENT_AMOUNT"; reason: string };

/** Deterministic, auditable obligation reference. */
function buildObligationRef(agreementId: string): string {
  return `OBL-${agreementId.replace(/-/g, "").slice(0, 12).toUpperCase()}`;
}

export async function createObligationForAgreement(
  agreementId: string,
  /**
   * Pass a transaction client to run inside a caller-managed transaction
   * (Stage 14A funding preparation); defaults to the module client.
   */
  options: { tx?: Prisma.TransactionClient } = {},
): Promise<ObligationCreationResult> {
  const db = options.tx ?? prisma;

  const agreement = await db.campaignAgreement.findUnique({
    where: { id: agreementId },
    select: {
      id: true,
      agreedAmount: true,
      currency: true,
      campaignId: true,
      advertiserId: true,
      creatorId: true,
      status: true,
    },
  });

  if (!agreement) {
    return {
      ok: false,
      code: "AGREEMENT_NOT_FOUND",
      reason: "No agreement exists with this id.",
    };
  }

  // Stage 12 frozen terms: the agreement amount IS the creator amount. The
  // conversion happens exactly once, server-side, right here.
  let creatorAmountMinor: bigint;

  try {
    creatorAmountMinor = toMinorUnits(agreement.agreedAmount.toString(), agreement.currency);
  } catch {
    return {
      ok: false,
      code: "INVALID_AGREEMENT_AMOUNT",
      reason: "The agreement amount cannot be represented exactly in minor units.",
    };
  }

  // Server-side fee configuration — never a client value, never a default 0.
  const feeResult = await getActiveFeeConfiguration(agreement.currency);

  if (!feeResult.ok) {
    // FEE_NOT_CONFIGURED is surfaced explicitly — never a silent 0% fee.
    return { ok: false, code: feeResult.code, reason: "No ACTIVE platform fee configuration exists for this currency." };
  }

  const amounts = computeObligationAmounts(creatorAmountMinor, feeResult.rate);

  if (!amounts.ok) {
    return {
      ok: false,
      code: amounts.code,
      reason:
        amounts.code === "FEE_NOT_CONFIGURED"
          ? "No ACTIVE platform fee configuration exists for this currency."
          : "The agreement amount cannot be represented exactly in minor units.",
    };
  }

  const obligationRef = buildObligationRef(agreementId);

  try {
    const created = await db.financialObligation.create({
      data: {
        agreementId,
        campaignId: agreement.campaignId,
        advertiserId: agreement.advertiserId,
        creatorId: agreement.creatorId,
        creatorAmountMinor: amounts.creatorAmountMinor,
        platformFeeMinor: amounts.platformFeeMinor,
        advertiserTotalMinor: amounts.advertiserTotalMinor,
        currency: agreement.currency,
        status: "PENDING_PAYMENT",
        obligationRef,
        feeConfigId: feeResult.feeConfig.id,
      },
      select: { id: true },
    });

    // The creation event is part of the obligation's audit trail. Written
    // after the obligation row; the event's unique key makes a retried
    // creation a no-op instead of a duplicate event.
    await db.financialEvent
      .create({
        data: {
          obligationId: created.id,
          agreementId,
          eventType: "obligation_created",
          actor: "SYSTEM",
          source: "obligation-service",
          metadata: {
            obligationRef,
            creatorAmountMinor: amounts.creatorAmountMinor.toString(),
            platformFeeMinor: amounts.platformFeeMinor.toString(),
            advertiserTotalMinor: amounts.advertiserTotalMinor.toString(),
            currency: agreement.currency,
            feeConfigId: feeResult.feeConfig.id,
          },
          idempotencyKey: `evt:${created.id}:obligation_created`,
        },
      })
      .catch(() => {
        // A duplicate event key can only occur on a replayed creation; the
        // obligation itself is the source of truth. Swallow only that case.
      });

    return {
      ok: true,
      obligationId: created.id,
      obligationRef,
      alreadyExisted: false,
      creatorAmountMinor: amounts.creatorAmountMinor,
      platformFeeMinor: amounts.platformFeeMinor,
      advertiserTotalMinor: amounts.advertiserTotalMinor,
      currency: agreement.currency,
    };
  } catch (error) {
    // Concurrent creation for the same agreement: the unique constraint on
    // agreementId wins the race — serve the existing obligation.
    if (isUniqueConstraintError(error)) {
      const existing = await db.financialObligation.findUnique({
        where: { agreementId },
        select: {
          id: true,
          obligationRef: true,
          creatorAmountMinor: true,
          platformFeeMinor: true,
          advertiserTotalMinor: true,
          currency: true,
        },
      });

      if (existing) {
        return {
          ok: true,
          obligationId: existing.id,
          obligationRef: existing.obligationRef,
          alreadyExisted: true,
          creatorAmountMinor: existing.creatorAmountMinor,
          platformFeeMinor: existing.platformFeeMinor,
          advertiserTotalMinor: existing.advertiserTotalMinor,
          currency: existing.currency,
        };
      }
    }

    console.error("createObligationForAgreement failed", error);
    return {
      ok: false,
      code: "INVALID_AGREEMENT_AMOUNT",
      reason: "Could not create the financial obligation.",
    };
  }
}

/**
 * Read one obligation with strict financial access control: only the
 * agreement's advertiser or creator (or an admin path) may see it.
 */
export async function getObligationForParty(
  obligationId: string,
  viewer: { advertiserId?: string; creatorId?: string },
) {
  const obligation = await prisma.financialObligation.findUnique({
    where: { id: obligationId },
  });

  if (!obligation) {
    return null;
  }

  const isAdvertiser =
    viewer.advertiserId !== undefined && obligation.advertiserId === viewer.advertiserId;
  const isCreator =
    viewer.creatorId !== undefined && obligation.creatorId === viewer.creatorId;

  if (!isAdvertiser && !isCreator) {
    return null;
  }

  return obligation;
}
