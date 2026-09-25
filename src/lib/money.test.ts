import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  advertiserTotalFor,
  assertAmountsConsistent,
  feeFor,
  formatMajor,
  InvalidMoneyError,
  isPositiveMinor,
  sumMinor,
  toMinorUnits,
  UnsupportedCurrencyError,
} from "@/lib/money";

/**
 * Stage 13A — money library tests.
 *
 * Pins the single Decimal → minor-unit conversion boundary: exact BigInt
 * results, rejection of invalid input, and no floating point anywhere.
 */

describe("money: Decimal → minor-unit conversion boundary", () => {
  it("converts NGN fixed-point strings to exact kobo", () => {
    assert.equal(toMinorUnits("1000.00", "NGN"), 100000n); // ₦1,000 = 100000 kobo
    assert.equal(toMinorUnits("180000.00", "NGN"), 18000000n);
    assert.equal(toMinorUnits("0.01", "NGN"), 1n);
    assert.equal(toMinorUnits("1000", "NGN"), 100000n);
    assert.equal(toMinorUnits("0.10", "NGN"), 10n);
    assert.equal(toMinorUnits("1.1", "NGN"), 110n);
  });

  it("is deterministic for the same input", () => {
    assert.equal(toMinorUnits("180000.00", "NGN"), toMinorUnits("180000.00", "NGN"));
  });

  it("rejects more than 2 decimal places for NGN", () => {
    assert.throws(() => toMinorUnits("10.999", "NGN"), InvalidMoneyError);
    assert.throws(() => toMinorUnits("0.001", "NGN"), InvalidMoneyError);
  });

  it("rejects negative amounts", () => {
    assert.throws(() => toMinorUnits("-5.00", "NGN"), InvalidMoneyError);
  });

  it("rejects empty and non-numeric input", () => {
    assert.throws(() => toMinorUnits("", "NGN"), InvalidMoneyError);
    assert.throws(() => toMinorUnits("  ", "NGN"), InvalidMoneyError);
    assert.throws(() => toMinorUnits("abc", "NGN"), InvalidMoneyError);
    assert.throws(() => toMinorUnits("12,000.00", "NGN"), InvalidMoneyError);
  });

  it("rejects scientific notation", () => {
    assert.throws(() => toMinorUnits("1e5", "NGN"), InvalidMoneyError);
  });

  it("rejects an unsupported currency", () => {
    assert.throws(() => toMinorUnits("10.00", "USD"), UnsupportedCurrencyError);
    assert.throws(() => toMinorUnits("10.00", "ngn"), UnsupportedCurrencyError);
  });

  it("never goes through floating point", () => {
    // The classic float trap: 0.1 + 0.2 !== 0.3. BigInt math is exact.
    assert.equal(toMinorUnits("0.10", "NGN") + toMinorUnits("0.20", "NGN"), 30n);
  });
});

describe("money: display formatting (boundary back out)", () => {
  it("formats minor units as fixed-point major strings", () => {
    assert.equal(formatMajor(18000000n, "NGN"), "180000.00");
    assert.equal(formatMajor(1n, "NGN"), "0.01");
    assert.equal(formatMajor(0n, "NGN"), "0.00");
  });

  it("rejects negative amounts", () => {
    assert.throws(() => formatMajor(-1n, "NGN"), InvalidMoneyError);
  });
});

describe("money: BigInt arithmetic helpers", () => {
  it("sums minor units exactly", () => {
    assert.equal(sumMinor([100000n, 250n, 1n]), 100251n);
    assert.equal(sumMinor([]), 0n);
  });

  it("computes the platform fee with floor rounding", () => {
    assert.equal(feeFor(18000000n, 1500n), 2700000n); // 15% of ₦180,000
    assert.equal(feeFor(18000000n, 0n), 0n);
    // 12.5% of ₦99.99 (9999 kobo) = 1249.875 kobo → floors to 1249.
    assert.equal(feeFor(9999n, 1250n), 1249n);
  });

  it("rejects negative basis points", () => {
    assert.throws(() => feeFor(1000n, -1n), InvalidMoneyError);
  });

  it("upholds creatorAmount + platformFee = advertiserTotal", () => {
    const creator = 18000000n;
    const fee = feeFor(creator, 1500n);
    const total = advertiserTotalFor(creator, fee);

    assert.equal(total, 20700000n); // ₦207,000.00
    assert.equal(creator + fee, total);
  });

  it("flags inconsistencies through the audit helper", () => {
    assert.doesNotThrow(() => assertAmountsConsistent(18000000n, 2700000n, 20700000n));
    assert.throws(
      () => assertAmountsConsistent(18000000n, 2700000n, 99999999n),
      InvalidMoneyError,
    );
    assert.throws(() => assertAmountsConsistent(0n, 0n, 0n), InvalidMoneyError);
  });

  it("identifies positive minor-unit amounts", () => {
    assert.equal(isPositiveMinor(1n), true);
    assert.equal(isPositiveMinor(0n), false);
  });
});
