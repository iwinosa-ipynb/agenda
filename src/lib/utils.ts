/** Minimal conditional className joiner (avoids adding a runtime dependency). */
export function cn(
  ...classes: Array<string | false | null | undefined>
): string {
  return classes.filter(Boolean).join(" ");
}

/**
 * Currency support is data-driven from the start so campaigns can be priced in
 * a currency other than naira without touching the UI layer.
 */
const CURRENCY_LOCALES = {
  NGN: "en-NG",
  USD: "en-US",
  GBP: "en-GB",
  EUR: "de-DE",
} as const;

export type SupportedCurrency = keyof typeof CURRENCY_LOCALES;

export function formatMoney(
  amount: number | string,
  currency: string = "NGN",
  options: { maximumFractionDigits?: number } = {},
): string {
  const numericAmount = typeof amount === "string" ? Number(amount) : amount;

  if (!Number.isFinite(numericAmount)) {
    return "—";
  }

  const locale = CURRENCY_LOCALES[currency as SupportedCurrency];

  // Unknown codes would make Intl throw, so fall back to a plain amount.
  if (!locale) {
    return `${new Intl.NumberFormat("en-NG").format(numericAmount)} ${currency}`;
  }

  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits: options.maximumFractionDigits ?? 0,
  }).format(numericAmount);
}

/** Compact follower/view counts, e.g. 12500 -> "12.5K". */
export function formatCount(value: number): string {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatDate(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("en-NG", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

export function formatDateTime(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("en-NG", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Whole days from now until the given date (negative when in the past). */
export function daysUntil(value: Date | string): number {
  const date = typeof value === "string" ? new Date(value) : value;
  return Math.ceil((date.getTime() - Date.now()) / 86_400_000);
}

/** True when a deadline exists and is already in the past. */
export function isDeadlinePassed(deadline: Date | null): boolean {
  return deadline !== null && deadline.getTime() < Date.now();
}

/** Human-friendly application deadline label. */
export function formatDeadline(value: Date | null): string {
  if (!value) {
    return "Open until filled";
  }

  const days = daysUntil(value);

  if (days < 0) {
    return `Closed on ${formatDate(value)}`;
  }
  if (days === 0) {
    return "Closes today";
  }
  if (days === 1) {
    return "Closes tomorrow";
  }
  return `Closes in ${days} days`;
}

/** Whole-number percentage helper for progress indicators. */
export function toPercentage(done: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Math.round((done / total) * 100);
}
