import "server-only";

/**
 * Stage 14B — Paystack configuration seam (server-only, fail closed).
 *
 * Conventions (mirroring cron-auth / token-encryption):
 *   - environment variables are read at USE time (never at module load) so
 *     imports stay side-effect free and tests can set/unset them;
 *   - a missing secret key means the provider is DORMANT: nothing calls
 *     Paystack, the webhook route answers 503, and no path invents a
 *     fake success — the same fail-closed posture as CRON_SECRET;
 *   - the secret key NEVER leaves the server: it is not logged, not stored
 *     in any event/payload metadata, and never exposed to client code.
 *
 * PAYSTACK_BASE_URL exists for testability; production defaults to the real
 * Paystack API. There is deliberately no NEXT_PUBLIC_* variable: the secret
 * must never reach the browser, and the implemented flow (server-rendered
 * redirect to Paystack's hosted page) needs no client-side key.
 */

const DEFAULT_BASE_URL = "https://api.paystack.co";

export type PaystackConfig = {
  secretKey: string;
  baseUrl: string;
};

/**
 * The Paystack configuration, or null when unconfigured (dormant mode).
 * Never throws — callers decide what dormant mode means for them.
 */
export function getPaystackConfig(): PaystackConfig | null {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;

  if (typeof secretKey !== "string" || secretKey.trim() === "") {
    return null;
  }

  const baseUrl = process.env.PAYSTACK_BASE_URL?.trim() || DEFAULT_BASE_URL;

  return { secretKey: secretKey.trim(), baseUrl: baseUrl.replace(/\/$/, "") };
}

/** True when Paystack is configured and the provider may be activated. */
export function isPaystackConfigured(): boolean {
  return getPaystackConfig() !== null;
}
