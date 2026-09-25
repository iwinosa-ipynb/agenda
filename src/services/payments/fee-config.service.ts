import "server-only";

import type { FeeConfigType, PlatformFeeConfig } from "@/generated/prisma/client";

import { prisma } from "@/lib/prisma";
import type { PlatformFeeRate } from "@/services/payments/fee-engine";

/**
 * Stage 13A/13B — server-side platform fee configuration.
 *
 * Stage 13A deferred the business decision; Stage 13B locks it in as typed
 * configuration rows (never hard-coded percentages in code):
 *
 *   AGREEMENT_FUNDING        — charged on top of the agreement at funding.
 *   MILESTONE_ADVERTISER_FEE — advertiser service fee EARNED per completed
 *                              milestone (5% under the locked 13B rules).
 *   MILESTONE_CREATOR_FEE    — creator marketplace commission EARNED per
 *                              completed milestone (10% under the locked
 *                              rules).
 *
 * If a row is missing the result is explicitly FEE_NOT_CONFIGURED — the
 * system never invents a fee and never defaults silently to 0. Percentages
 * live ONLY in the database; changing them is an operational act, not a
 * code change.
 */

export type FeeConfigurationResult =
  | { ok: true; feeConfig: PlatformFeeConfig; rate: PlatformFeeRate }
  | { ok: false; code: "FEE_NOT_CONFIGURED" };

async function getActiveFeeConfigOfType(
  currency: string,
  feeType: FeeConfigType,
): Promise<FeeConfigurationResult> {
  const feeConfig = await prisma.platformFeeConfig.findFirst({
    where: { currency, feeType, status: "ACTIVE" },
  });

  if (!feeConfig) {
    return { ok: false, code: "FEE_NOT_CONFIGURED" };
  }

  return {
    ok: true,
    feeConfig,
    rate: { feeBasisPoints: BigInt(feeConfig.feeBasisPoints) },
  };
}

/**
 * The ACTIVE agreement-funding fee configuration for a currency (Stage 13A
 * obligation creation path), or an explicit FEE_NOT_CONFIGURED condition.
 */
export async function getActiveFeeConfiguration(
  currency: string,
): Promise<FeeConfigurationResult> {
  return getActiveFeeConfigOfType(currency, "AGREEMENT_FUNDING");
}

/**
 * The ACTIVE milestone advertiser service fee for a currency (Stage 13B).
 * Earned per completed milestone only.
 */
export function getActiveAdvertiserMilestoneFeeConfiguration(
  currency: string,
): Promise<FeeConfigurationResult> {
  return getActiveFeeConfigOfType(currency, "MILESTONE_ADVERTISER_FEE");
}

/**
 * The ACTIVE creator marketplace commission for a currency (Stage 13B).
 * Earned per completed milestone only.
 */
export function getActiveCreatorMilestoneFeeConfiguration(
  currency: string,
): Promise<FeeConfigurationResult> {
  return getActiveFeeConfigOfType(currency, "MILESTONE_CREATOR_FEE");
}

/**
 * Both milestone fee configurations in one read pass. Either one missing is
 * an explicit FEE_NOT_CONFIGURED — milestone amounts can never be frozen
 * with one fee silently defaulted.
 */
export async function getMilestoneFeeConfigurations(
  currency: string,
): Promise<
  | {
      ok: true;
      advertiserFee: PlatformFeeConfig;
      creatorFee: PlatformFeeConfig;
      advertiserRate: PlatformFeeRate;
      creatorRate: PlatformFeeRate;
    }
  | { ok: false; code: "FEE_NOT_CONFIGURED" }
> {
  const [advertiser, creator] = await Promise.all([
    getActiveAdvertiserMilestoneFeeConfiguration(currency),
    getActiveCreatorMilestoneFeeConfiguration(currency),
  ]);

  if (!advertiser.ok || !creator.ok) {
    return { ok: false, code: "FEE_NOT_CONFIGURED" };
  }

  return {
    ok: true,
    advertiserFee: advertiser.feeConfig,
    creatorFee: creator.feeConfig,
    advertiserRate: advertiser.rate,
    creatorRate: creator.rate,
  };
}
