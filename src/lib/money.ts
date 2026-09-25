/**
 * Stage 13A — money library (server-side financial arithmetic).
 *
 * Rules of this module:
 *
 *   - ALL financial amounts are BigInt integers in MINOR UNITS (kobo for NGN:
 *     ₦1,000.00 = 100000). No floating-point value ever represents a creator
 *     amount, platform fee, advertiser total, refund, payout or ledger entry.
 *   - This file is the SINGLE conversion boundary between Stage 12's
 *     Decimal(14,2) agreement amounts (serialized as fixed-point strings) and
 *     financial minor units. Parsing rejects anything that is not exactly 2
 *     decimal places and produces deterministic minor units.
 *   - Rendering may convert minor units back to display strings via
 *     `formatMajor`, but the result is presentation only — it must never be
 *     parsed back for further financial arithmetic.
 *
 * Prisma's Decimal serializes to a fixed-point string ("180000.00"); that
 * string is the input this module accepts. `Number(...)` is used ONLY as a
 * limited sanity check on magnitude and is never used to compute money.
 */

/** Supported financial currency (Stage 13A scope: NGN only). */
export const SUPPORTED_CURRENCIES = ["NGN"] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

/** Minor units per major unit, per supported currency. */
export const CURRENCY_MINOR_UNITS: Record<SupportedCurrency, number> = {
  NGN: 100,
};

/** Thrown when a money value cannot be represented exactly in minor units. */
export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMoneyError";
  }
}

/** Thrown when a currency is not supported by the financial layer. */
export class UnsupportedCurrencyError extends Error {
  constructor(currency: string) {
    super(`Unsupported currency for financial operations: ${currency}`);
    this.name = "UnsupportedCurrencyError";
  }
}

export function isSupportedCurrency(currency: string): currency is SupportedCurrency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(currency);
}

function minorFactor(currency: string): bigint {
  if (!isSupportedCurrency(currency)) {
    throw new UnsupportedCurrencyError(currency);
  }

  return BigInt(CURRENCY_MINOR_UNITS[currency]);
}

/** Number of decimal digits in the minor unit (NGN kobo → 2). */
function minorUnitDigits(currency: string): number {
  if (!isSupportedCurrency(currency)) {
    throw new UnsupportedCurrencyError(currency);
  }

  return String(CURRENCY_MINOR_UNITS[currency]).length - 1;
}

/**
 * THE conversion boundary: fixed-point string (Prisma Decimal serialization
 * of a Decimal(14,2) column) → BigInt minor units.
 *
 * Deterministic and exact:
 *   toMinorUnits("180000.00", "NGN") === 18000000n
 *   toMinorUnits("1000", "NGN")      === 100000n
 *
 * Rejects: empty/absent input, non-numeric text, negative amounts, values
 * with more than 2 decimal places, scientific notation, and magnitudes that
 * overflow 64-bit signed integers.
 */
export function toMinorUnits(decimalString: string, currency: string): bigint {
  if (typeof decimalString !== "string") {
    throw new InvalidMoneyError("Money must be provided as a fixed-point string.");
  }

  const trimmed = decimalString.trim();

  if (trimmed.length === 0) {
    throw new InvalidMoneyError("Money string is empty.");
  }

  if (trimmed.includes("e") || trimmed.includes("E")) {
    throw new InvalidMoneyError(`Scientific notation is not a valid money value: ${trimmed}`);
  }

  if (trimmed.startsWith("-")) {
    throw new InvalidMoneyError(`Negative amounts are not valid here: ${trimmed}`);
  }

  // Exactly: optional integer part, optional single dot, 1-2 fraction digits.
  if (!/^\d{1,15}(\.\d{1,2})?$/.test(trimmed)) {
    throw new InvalidMoneyError(
      `Amount must be a plain decimal with at most 2 decimal places: ${trimmed}`,
    );
  }

  const factor = minorFactor(currency);
  const digits = minorUnitDigits(currency);
  const [wholePart, fractionPart = ""] = trimmed.split(".");
  const whole = BigInt(wholePart);
  // Fraction digits are zero-padded to the minor-unit digit width. At most 2
  // digits reach here, so this is exact for NGN.
  const fraction = BigInt(fractionPart.padEnd(digits, "0").slice(0, digits) || "0");

  return whole * factor + fraction;
}

/**
 * Inverse for DISPLAY only: minor units → fixed-point major string.
 * formatMajor(18000000n, "NGN") === "180000.00". Never feed the result back
 * into financial arithmetic — re-parse only via toMinorUnits at boundaries.
 */
export function formatMajor(amountMinor: bigint, currency: string): string {
  if (amountMinor < 0n) {
    throw new InvalidMoneyError("Cannot format a negative amount.");
  }

  const factor = minorFactor(currency);
  const digits = minorUnitDigits(currency);
  const whole = amountMinor / factor;
  const fraction = amountMinor % factor;

  return `${whole}.${fraction.toString().padStart(digits, "0")}`;
}

/** True when the amount is a non-negative integer in minor units. */
export function isNonNegativeMinor(value: bigint): boolean {
  return value >= 0n;
}

/** True when the amount is a positive integer in minor units (> 0). */
export function isPositiveMinor(value: bigint): boolean {
  return value > 0n;
}

/** Sum of an array of minor-unit amounts (BigInt arithmetic only). */
export function sumMinor(values: bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

/**
 * Platform fee for a creator amount, in minor units, from basis points.
 * Integer division rounds DOWN — a fee can never exceed its configured rate.
 *   feeFor(18000000n, 1500n) === 2700000n  (15% of ₦180,000 = ₦27,000)
 */
export function feeFor(creatorAmountMinor: bigint, feeBasisPoints: bigint): bigint {
  if (feeBasisPoints < 0n) {
    throw new InvalidMoneyError("Fee basis points cannot be negative.");
  }

  return (creatorAmountMinor * feeBasisPoints) / 10000n;
}

/**
 * The invariant the whole financial layer rests on:
 * creatorAmount + platformFee === advertiserTotal.
 */
export function advertiserTotalFor(
  creatorAmountMinor: bigint,
  platformFeeMinor: bigint,
): bigint {
  return creatorAmountMinor + platformFeeMinor;
}

/** Deterministic check used by tests and audits on the core invariant. */
export function assertAmountsConsistent(
  creatorAmountMinor: bigint,
  platformFeeMinor: bigint,
  advertiserTotalMinor: bigint,
): void {
  if (!isPositiveMinor(creatorAmountMinor)) {
    throw new InvalidMoneyError("Creator amount must be positive.");
  }

  if (!isNonNegativeMinor(platformFeeMinor)) {
    throw new InvalidMoneyError("Platform fee cannot be negative.");
  }

  if (advertiserTotalMinor !== advertiserTotalFor(creatorAmountMinor, platformFeeMinor)) {
    throw new InvalidMoneyError(
      "Amounts violate creatorAmount + platformFee = advertiserTotal.",
    );
  }
}
