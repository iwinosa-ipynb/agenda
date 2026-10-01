/**
 * Pure pricing math (Stage 12). No I/O, no server-only — so the numbers behind
 * marketplace guidance can be unit-tested directly.
 *
 * Rule of the whole guidance layer: every range is computed from real
 * accepted-agreement history supplied by the caller, and when that history is
 * too thin the result is explicitly INSUFFICIENT_DATA. Nothing here invents a
 * number.
 */

/** Minimum distinct agreements required before any range is published. */
export const MIN_GUIDANCE_SAMPLE = 5;

/** How much of the sample a single agreement may dominate before we refuse. */
const MAX_SINGLE_SAMPLE_SHARE = 0.8;

export type DataAvailability = "AVAILABLE" | "INSUFFICIENT_DATA";

export type GuidanceRange = {
  dataAvailability: DataAvailability;
  /** Inclusive suggested range bounds as fixed-point strings; null when insufficient. */
  suggestedMin: string | null;
  suggestedMax: string | null;
  /** Distinct historical data points the range is based on. */
  sampleSize: number;
};

/**
 * Linear-interpolation percentile over numeric values (0 <= p <= 1).
 * Caller guarantees a non-empty array.
 */
export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);

  if (lower === upper) {
    return sorted[lower];
  }

  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/**
 * Build an inclusive p25–p75 guidance range from real history. Returns
 * INSUFFICIENT_DATA (no numbers at all) when the sample is too small or too
 * concentrated (one agreement dominating everything is not a market signal).
 */
export function buildGuidanceRange(samples: number[]): GuidanceRange {
  const clean = samples.filter(
    (value) => Number.isFinite(value) && value > 0,
  );

  if (clean.length < MIN_GUIDANCE_SAMPLE) {
    return {
      dataAvailability: "INSUFFICIENT_DATA",
      suggestedMin: null,
      suggestedMax: null,
      sampleSize: clean.length,
    };
  }

  const total = clean.reduce((sum, value) => sum + value, 0);
  const largest = Math.max(...clean);

  if (largest > total * MAX_SINGLE_SAMPLE_SHARE) {
    return {
      dataAvailability: "INSUFFICIENT_DATA",
      suggestedMin: null,
      suggestedMax: null,
      sampleSize: clean.length,
    };
  }

  // Round to whole currency units and widen by ±10% so the band is advisory
  // rather than a claim of precision.
  const min = Math.round(percentile(clean, 0.25) * 0.9);
  const max = Math.round(percentile(clean, 0.75) * 1.1);

  // A degenerate history (identical values) still yields a valid band.
  if (max <= min) {
    return {
      dataAvailability: "AVAILABLE",
      suggestedMin: min.toFixed(2),
      suggestedMax: (min * 1.2).toFixed(2),
      sampleSize: clean.length,
    };
  }

  return {
    dataAvailability: "AVAILABLE",
    suggestedMin: min.toFixed(2),
    suggestedMax: max.toFixed(2),
    sampleSize: clean.length,
  };
}

/**
 * Advisory threshold for the soft low-quote warning. A quote must fall below
 * this fraction of the suggested minimum before the creator sees a nudge — so
 * a tiny rounding difference (e.g. quoting ₦107,900 against a ₦108,000
 * minimum) never triggers it. This is guidance only: it never constrains or
 * rewrites the quote the creator actually submits.
 */
export const LOW_QUOTE_WARNING_FACTOR = 0.9;

/** The guidance shape the warning helper needs — a structural subset so this
 * module stays free of service imports and remains directly unit-testable. */
export type QuoteGuidanceInput = {
  dataAvailability: DataAvailability;
  suggestedMin: string | null;
  suggestedMax?: string | null;
};

/**
 * Soft, purely-advisory low-quote warning for the apply form.
 *
 * Returns a message ONLY when all of the following hold:
 *   - guidance is AVAILABLE (a real data-backed range exists);
 *   - a numeric suggestedMin is present;
 *   - the creator's entered quote is a valid positive number that falls
 *     MEANINGFULLY below suggestedMin (< suggestedMin × LOW_QUOTE_WARNING_FACTOR).
 *
 * Returns null otherwise: empty/invalid quote, quote at or above the minimum,
 * INSUFFICIENT_DATA, or missing guidance numbers. It NEVER blocks, clamps or
 * rewrites the quote — the exact amount remains the creator's to submit.
 */
export function getQuoteGuidanceWarning(
  quote: string | number | null | undefined,
  guidance: QuoteGuidanceInput | null | undefined,
): string | null {
  if (!guidance || guidance.dataAvailability !== "AVAILABLE") {
    return null;
  }

  if (guidance.suggestedMin === null || guidance.suggestedMin === undefined) {
    return null;
  }

  const suggestedMin = Number(guidance.suggestedMin);

  if (!Number.isFinite(suggestedMin) || suggestedMin <= 0) {
    return null;
  }

  const numeric =
    typeof quote === "number"
      ? quote
      : Number(String(quote ?? "").trim());

  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  if (numeric >= suggestedMin * LOW_QUOTE_WARNING_FACTOR) {
    return null;
  }

  return "Your fee is below the typical range for similar campaigns. This is only guidance — quote what your work is worth to you, and submit whenever you're ready.";
}

/** Fixed-point string for a validated money value (server-side canonical form). */
export function toMoneyString(value: number): string {
  return value.toFixed(2);
}
