/**
 * Stage 13A — pure fee-engine logic (no I/O, no server-only import), so the
 * arithmetic behind obligation creation can be unit-tested directly, mirroring
 * src/lib/pricing-math.ts.
 *
 * The invariant: creatorAmountMinor + platformFeeMinor === advertiserTotalMinor.
 * Everything is BigInt minor units; no floating point anywhere.
 */

import {
  advertiserTotalFor,
  feeFor,
  isPositiveMinor,
  InvalidMoneyError,
} from "@/lib/money";

export type PlatformFeeRate = { feeBasisPoints: bigint };

/**
 * Which advertiser fee mechanism an agreement uses.
 *
 * Agenda charges the advertiser through EXACTLY ONE of these two paths —
 * never both on the same agreement amount:
 *
 *   SINGLE_PAYMENT — a normal/single-payment agreement. The 5%
 *                    AGREEMENT_FUNDING fee is charged UPFRONT, as part of
 *                    the provider-verified advertiser total at funding. The
 *                    per-milestone advertiser fee is therefore ZERO.
 *
 *   MILESTONE      — a longer campaign split across several milestones. The
 *                    advertiser funds ONLY the creator's agreed money
 *                    upfront; the 5% MILESTONE_ADVERTISER_FEE is charged
 *                    per milestone at settlement, from the advertiser and
 *                    NEVER out of escrow. AGREEMENT_FUNDING is zero.
 *
 * The mode is derived once, by the funding flow, from the number of
 * explicit milestone terms the advertiser submitted (one term = a
 * single-payment agreement). It is then frozen into the obligation.
 */
export type AgreementFeeMode = "SINGLE_PAYMENT" | "MILESTONE";

/** The zero rate used when an agreement is not charged a funding fee. */
export const ZERO_FEE_RATE: PlatformFeeRate = { feeBasisPoints: 0n };

/** True when the agreement collects its advertiser fee per milestone. */
export function chargesFeePerMilestone(mode: AgreementFeeMode): boolean {
  return mode === "MILESTONE";
}

export type FeeComputation =
  | {
      ok: true;
      creatorAmountMinor: bigint;
      platformFeeMinor: bigint;
      advertiserTotalMinor: bigint;
    }
  | { ok: false; code: "FEE_NOT_CONFIGURED" | "INVALID_AGREEMENT_AMOUNT" };

/**
 * Derive the full amount triple from the frozen agreement amount and the
 * server-side fee rate. The creator amount is ALWAYS the agreement amount —
 * never a rate-card price, never a campaign budget, never client input.
 */
export function computeObligationAmounts(
  creatorAmountMinor: bigint,
  rate: PlatformFeeRate | null,
): FeeComputation {
  if (!isPositiveMinor(creatorAmountMinor)) {
    return { ok: false, code: "INVALID_AGREEMENT_AMOUNT" };
  }

  if (!rate) {
    return { ok: false, code: "FEE_NOT_CONFIGURED" };
  }

  const platformFeeMinor = feeFor(creatorAmountMinor, rate.feeBasisPoints);
  const advertiserTotalMinor = advertiserTotalFor(
    creatorAmountMinor,
    platformFeeMinor,
  );

  return {
    ok: true,
    creatorAmountMinor,
    platformFeeMinor,
    advertiserTotalMinor,
  };
}

/** Guard so malformed inputs fail loudly instead of writing bad money rows. */
export function assertFeeComputationValid(computation: FeeComputation): void {
  if (!computation.ok) {
    throw new InvalidMoneyError(`Fee computation failed: ${computation.code}`);
  }
}
