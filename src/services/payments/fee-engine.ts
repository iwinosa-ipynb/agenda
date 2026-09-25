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
