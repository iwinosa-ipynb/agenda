import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeObligationAmounts } from "@/services/payments/fee-engine";

/**
 * Stage 13A — fee engine tests.
 *
 * Pins:
 *   - creatorAmount + platformFee = advertiserTotal (BigInt, exact);
 *   - FEE_NOT_CONFIGURED is an explicit condition, never a silent 0;
 *   - floor rounding keeps fees honest for odd amounts.
 */

describe("fee engine", () => {
  it("derives the amount triple from creator amount and rate", () => {
    const result = computeObligationAmounts(18000000n, { feeBasisPoints: 1500n });

    assert.equal(result.ok, true);

    if (result.ok) {
      assert.equal(result.creatorAmountMinor, 18000000n);
      assert.equal(result.platformFeeMinor, 2700000n);
      assert.equal(result.advertiserTotalMinor, 20700000n);
      assert.equal(
        result.creatorAmountMinor + result.platformFeeMinor,
        result.advertiserTotalMinor,
      );
    }
  });

  it("exposes FEE_NOT_CONFIGURED when no rate exists (never defaults to 0)", () => {
    const result = computeObligationAmounts(18000000n, null);

    assert.deepEqual(result, { ok: false, code: "FEE_NOT_CONFIGURED" });
  });

  it("rejects non-positive creator amounts", () => {
    assert.equal(computeObligationAmounts(0n, { feeBasisPoints: 1500n }).ok, false);
    const negative = computeObligationAmounts(-5n, { feeBasisPoints: 1500n });

    assert.equal(negative.ok, false);

    if (!negative.ok) {
      assert.equal(negative.code, "INVALID_AGREEMENT_AMOUNT");
    }
  });

  it("floors fractional kobo fees without losing the invariant", () => {
    const result = computeObligationAmounts(9999n, { feeBasisPoints: 1250n });

    assert.equal(result.ok, true);

    if (result.ok) {
      assert.equal(result.platformFeeMinor, 1249n); // 1249.875 floored
      assert.equal(
        result.creatorAmountMinor + result.platformFeeMinor,
        result.advertiserTotalMinor,
      );
    }
  });

  it("handles a zero-fee configuration without inventing one", () => {
    // An operator may configure 0% — that is a decision, not a default.
    const result = computeObligationAmounts(18000000n, { feeBasisPoints: 0n });

    assert.equal(result.ok, true);

    if (result.ok) {
      assert.equal(result.platformFeeMinor, 0n);
      assert.equal(result.advertiserTotalMinor, 18000000n);
    }
  });
});
