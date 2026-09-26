import "server-only";

import crypto from "node:crypto";

import {
  configurePaymentProvider,
  hasPaymentProvider,
  type PayoutRequest,
  type PayoutResult,
  type RecipientRequest,
  type RecipientResult,
  type ChargeResult,
  type PaymentProvider,
  type RefundRequest,
  type RefundResult,
  type TransferStatusRequest,
  type TransferStatusResult,
  type VerificationRequest,
  type VerificationResult,
  type WebhookVerificationRequest,
  type WebhookVerificationResult,
} from "@/services/payments/index";
import { getPaystackConfig, type PaystackConfig } from "@/services/payments/paystack.config";

/**
 * Stage 14B — Paystack adapter behind the existing Stage 13A port.
 *
 * Scope (deliberately narrow):
 *   - initializeTransaction  → createCharge (returns requires_action + redirectUrl);
 *   - verify/:reference      → verifyTransaction (THE FUNDED gate);
 *   - x-paystack-signature   → verifyWebhook (HMAC-SHA512 over RAW bytes).
 *
 * Payouts, transfers, recipients and refunds are NOT implemented in this
 * stage (per scope): the methods return the port's explicit failed/unknown
 * shapes so no caller can mistake them for a silent success.
 *
 * Money discipline:
 *   - the adapter receives and returns BigInt minor units only;
 *   - Paystack NGN amounts are INTEGER KOBO — the adapter stringifies BigInt
 *     values and parses provider amounts as base-10 integers. No float ever
 *     touches an amount.
 *
 * Failure mapping (audit §7):
 *   - HTTP 4xx/5xx, malformed responses and network/time-out errors map to
 *     {status:"failed"} / {status:"unverified"} — never to a success shape;
 *   - an unreachable provider during VERIFICATION is classified explicitly as
 *     "provider_unavailable" so the funding service can leave the obligation
 *     in PROCESSING (a timeout is NOT evidence of payment failure).
 */

type PaystackInitializeResponse = {
  status: boolean;
  message: string;
  data?: { authorization_url?: string; access_code?: string; reference?: string };
};

type PaystackVerifyResponse = {
  status: boolean;
  message: string;
  data?: {
    id?: number;
    status?: string;
    amount?: number;
    currency?: string;
    paid_at?: string;
    reference?: string;
  };
};

type PaystackRecipientResponse = {
  status: boolean;
  message: string;
  data?: { recipient_code?: string; details?: { account_name?: string } };
};

type PaystackTransferResponse = {
  status: boolean;
  message: string;
  data?: { transfer_code?: string; reference?: string; status?: string };
};

/** Injectable HTTP boundary (tests substitute fetch; production uses global). */
export type PaystackFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

const REQUEST_TIMEOUT_MS = 15_000;

function timeoutError(): Error {
  const error = new Error("Paystack request timed out");

  error.name = "PaystackTimeoutError";

  return error;
}

async function paystackFetch(
  baseUrl: string,
  path: string,
  secretKey: string,
  init: { method: string; body?: string },
  fetchImpl: PaystackFetch,
): Promise<{ status: number; body: string }> {
  // Latency is bounded by withTimeout() around this call (and the real fetch
  // additionally aborts via AbortSignal.timeout) — the adapter never hangs.
  const response = await fetchImpl(`${baseUrl}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: init.body,
  });

  return { status: response.status, body: await response.text() };
}

function withTimeout<T>(promise: Promise<T>, ms = REQUEST_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(timeoutError()), ms)),
  ]);
}

/** The production HTTP boundary: global fetch with a hard timeout. */
function defaultFetch(url: string, init: { method: string; headers: Record<string, string>; body?: string }) {
  return fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

export class PaystackProvider implements PaymentProvider {
  readonly name = "paystack";

  constructor(
    private readonly config: PaystackConfig,
    private readonly fetchImpl: PaystackFetch = defaultFetch,
    /**
     * Resolves the advertiser's Paystack-ready email from their profile id.
     * Paystack requires an email per transaction; it is resolved SERVER-SIDE
     * from the advertiser's account — never accepted from the client.
     */
    private readonly resolveAdvertiserEmail: (
      advertiserId: string,
    ) => Promise<string | null> = async () => null,
  ) {}

  // -------------------------------------------------------------------------
  // Charge initialization — POST /transaction/initialize
  // -------------------------------------------------------------------------

  async createCharge(request: {
    advertiserId: string;
    campaignId: string;
    amountMinor: bigint;
    currency: string;
    reference: string;
  }): Promise<ChargeResult> {
    const email = await this.resolveAdvertiserEmail(request.advertiserId);

    if (!email) {
      return {
        status: "failed",
        providerReference: null,
        reason: "Advertiser email is not available for the charge.",
      };
    }

    const body = JSON.stringify({
      // INTEGER KOBO as a string-safe number: BigInt → string, never a float.
      amount: request.amountMinor.toString(),
      email,
      currency: request.currency,
      reference: request.reference,
      // No split/payment-override fields are sent — amounts are server-derived.
    });

    let response: { status: number; body: string };

    try {
      response = await withTimeout(
        paystackFetch(
          this.config.baseUrl,
          "/transaction/initialize",
          this.config.secretKey,
          { method: "POST", body },
          this.fetchImpl,
        ),
      );
    } catch (error) {
      // Network failure / timeout during INITIALIZATION is a charge failure:
      // no charge exists provider-side, and the local transaction row will
      // record the attempt with its reason.
      const timedOut = (error as { name?: string }).name === "PaystackTimeoutError";

      return {
        status: "failed",
        providerReference: null,
        reason: timedOut
          ? "Paystack did not respond while initializing the charge."
          : "Paystack could not be reached while initializing the charge.",
      };
    }

    let parsed: PaystackInitializeResponse;

    try {
      parsed = JSON.parse(response.body) as PaystackInitializeResponse;
    } catch {
      return {
        status: "failed",
        providerReference: null,
        reason: "Paystack returned a malformed initialization response.",
      };
    }

    if (
      response.status !== 200 && response.status !== 201 ||
      parsed.status !== true ||
      typeof parsed.data?.authorization_url !== "string" ||
      typeof parsed.data?.access_code !== "string"
    ) {
      return {
        status: "failed",
        providerReference: null,
        reason:
          typeof parsed.message === "string" && parsed.message.length > 0
            ? `Paystack rejected the charge: ${parsed.message.slice(0, 300)}`
            : "Paystack rejected the charge.",
      };
    }

    return {
      status: "requires_action",
      providerReference: parsed.data.access_code,
      redirectUrl: parsed.data.authorization_url,
    };
  }

  // -------------------------------------------------------------------------
  // Server-side verification — GET /transaction/verify/:reference
  // -------------------------------------------------------------------------

  async verifyTransaction(request: VerificationRequest): Promise<VerificationResult> {
    let response: { status: number; body: string };

    try {
      response = await withTimeout(
        paystackFetch(
          this.config.baseUrl,
          `/transaction/verify/${encodeURIComponent(request.providerReference)}`,
          this.config.secretKey,
          { method: "GET" },
          this.fetchImpl,
        ),
      );
    } catch (error) {
      // Timeout/network during VERIFICATION is UNCERTAINTY, not failure: the
      // caller must leave the obligation in PROCESSING. Classified explicitly.
      const timedOut = (error as { name?: string }).name === "PaystackTimeoutError";

      return {
        status: "unverified",
        providerReference: request.providerReference,
        reason: timedOut
          ? "provider_unavailable: Paystack did not respond while verifying."
          : "provider_unavailable: Paystack could not be reached while verifying.",
      };
    }

    let parsed: PaystackVerifyResponse;

    try {
      parsed = JSON.parse(response.body) as PaystackVerifyResponse;
    } catch {
      return {
        status: "unverified",
        providerReference: request.providerReference,
        reason: "Paystack returned a malformed verification response.",
      };
    }

    if (response.status !== 200 || parsed.status !== true || !parsed.data) {
      return {
        status: "unverified",
        providerReference: request.providerReference,
        reason: "Paystack could not verify this reference.",
      };
    }

    const data = parsed.data;

    // Paystack's canonical success marker is data.status === "success".
    if (data.status !== "success") {
      return {
        status: "unverified",
        providerReference: request.providerReference,
        reason: `Paystack reports the transaction as ${data.status ?? "unknown"}.`,
      };
    }

    // Provider amounts are integer kobo — parse as base-10 integer, no float.
    const amountMinor =
      typeof data.amount === "number" && Number.isInteger(data.amount)
        ? BigInt(data.amount)
        : null;

    if (amountMinor === null) {
      return {
        status: "unverified",
        providerReference: request.providerReference,
        reason: "Paystack verification returned a non-integer amount.",
      };
    }

    // THE amount gate is enforced here AND re-checked by the funding service
    // against the frozen obligation (defense in depth).
    if (amountMinor !== request.expectedAmountMinor) {
      return {
        status: "unverified",
        providerReference: request.providerReference,
        reason: "Verified amount does not match the obligation's expected total.",
      };
    }

    if (data.currency !== request.currency) {
      return {
        status: "unverified",
        providerReference: request.providerReference,
        reason: "Verified currency does not match the obligation's currency.",
      };
    }

    return {
      status: "verified",
      providerReference: request.providerReference,
      providerStatus: "SUCCEEDED",
      amountMinor,
      currency: data.currency,
      paidAt: typeof data.paid_at === "string" ? data.paid_at : null,
      raw: { status: data.status, amount: data.amount, currency: data.currency, reference: data.reference ?? null },
    };
  }

  // -------------------------------------------------------------------------
  // Webhook verification — HMAC-SHA512 over the RAW request bytes
  // -------------------------------------------------------------------------

  async verifyWebhook(request: WebhookVerificationRequest): Promise<WebhookVerificationResult> {
    const signature = request.headers["x-paystack-signature"];

    if (typeof signature !== "string" || signature.length === 0) {
      return { verified: false, reason: "Missing x-paystack-signature header." };
    }

    const expected = crypto
      .createHmac("sha512", this.config.secretKey)
      .update(request.rawBody, "utf8")
      .digest("hex");

    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(signature.trim().toLowerCase(), "hex");

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { verified: false, reason: "Webhook signature mismatch." };
    }

    let payload: Record<string, unknown>;

    try {
      payload = JSON.parse(request.rawBody) as Record<string, unknown>;
    } catch {
      return { verified: false, reason: "Webhook body is not valid JSON." };
    }

    const eventType = typeof payload.event === "string" ? payload.event : null;
    const data = payload.data as Record<string, unknown> | undefined;

    // Paystack has no native event id: synthesize a STABLE identity for the
    // (provider, providerEventId) dedupe — event + the transaction's unique
    // id (charge.success / charge.failed both carry a stable data.id). When
    // no stable id can be synthesized, providerEventId stays null and the
    // existing route stores the delivery as SKIPPED (never processed).
    let providerEventId: string | null = null;

    if (eventType !== null && data && typeof data.id === "number" && Number.isInteger(data.id)) {
      providerEventId = `${eventType}:${data.id}`;
    } else if (
      eventType !== null &&
      data &&
      typeof data.reference === "string" &&
      data.reference.length > 0
    ) {
      providerEventId = `${eventType}:${data.reference}`;
    }

    return {
      verified: true,
      event: {
        providerEventId,
        eventType,
        payload,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Recipient creation — POST /transferrecipient (Stage 14C)
  // -------------------------------------------------------------------------

  async createRecipient(request: RecipientRequest): Promise<RecipientResult> {
    // Server-side name resolution first: Paystack resolves the account name
    // for the account number, and it MUST match the creator's registered
    // name — a mismatch is refused (no payouts to arbitrary accounts).
    let resolvedName: string | null = null;

    try {
      const verifyResponse = await withTimeout(
        paystackFetch(
          this.config.baseUrl,
          `/bank/resolve?account_number=${encodeURIComponent(request.bankAccount.accountNumber)}&bank_code=${encodeURIComponent(request.bankAccount.bankCode)}`,
          this.config.secretKey,
          { method: "GET" },
          this.fetchImpl,
        ),
      );

      const parsed = JSON.parse(verifyResponse.body) as {
        status: boolean;
        data?: { account_name?: string };
      };

      if (verifyResponse.status === 200 && parsed.status === true && typeof parsed.data?.account_name === "string") {
        resolvedName = parsed.data.account_name;
      }
    } catch {
      // Resolution is best-effort; Paystack re-validates on recipient create.
    }

    if (resolvedName === null) {
      return { status: "failed", reason: "The bank account could not be resolved — check the account number and bank." };
    }

    const normalizedResolved = resolvedName.replace(/\s+/g, " ").trim().toLowerCase();
    const normalizedExpected = request.bankAccount.accountName.replace(/\s+/g, " ").trim().toLowerCase();

    if (normalizedResolved !== normalizedExpected) {
      return {
        status: "failed",
        reason: "The account name does not match the bank account — payouts must go to the creator's own account.",
      };
    }

    let response: { status: number; body: string };

    try {
      response = await withTimeout(
        paystackFetch(
          this.config.baseUrl,
          "/transferrecipient",
          this.config.secretKey,
          {
            method: "POST",
            body: JSON.stringify({
              type: "nuban",
              name: resolvedName,
              account_number: request.bankAccount.accountNumber,
              bank_code: request.bankAccount.bankCode,
              currency: request.currency,
            }),
          },
          this.fetchImpl,
        ),
      );
    } catch {
      return { status: "failed", reason: "Paystack could not be reached while creating the recipient." };
    }

    let parsed: PaystackRecipientResponse;

    try {
      parsed = JSON.parse(response.body) as PaystackRecipientResponse;
    } catch {
      return { status: "failed", reason: "Paystack returned a malformed recipient response." };
    }

    if (
      (response.status !== 200 && response.status !== 201) ||
      parsed.status !== true ||
      typeof parsed.data?.recipient_code !== "string"
    ) {
      return {
        status: "failed",
        reason:
          typeof parsed.message === "string" && parsed.message.length > 0
            ? `Paystack rejected the recipient: ${parsed.message.slice(0, 300)}`
            : "Paystack rejected the recipient.",
      };
    }

    return {
      status: "created",
      recipientCode: parsed.data.recipient_code,
    };
  }

  // -------------------------------------------------------------------------
  // Transfer creation — POST /transfer (Stage 14C)
  // -------------------------------------------------------------------------

  async createPayout(request: PayoutRequest): Promise<PayoutResult> {
    let response: { status: number; body: string };

    try {
      response = await withTimeout(
        paystackFetch(
          this.config.baseUrl,
          "/transfer",
          this.config.secretKey,
          {
            method: "POST",
            // amount: INTEGER KOBO (BigInt → string). source: "balance" —
            // payouts leave the platform's Paystack balance.
            body: JSON.stringify({
              source: "balance",
              amount: request.amountMinor.toString(),
              recipient: request.recipientCode,
              reason: `Agenda payout ${request.reference}`,
              reference: request.reference,
              currency: request.currency,
            }),
          },
          this.fetchImpl,
        ),
      );
    } catch {
      // Uncertainty, not failure: the request may or may not have landed
      // provider-side, so the attempt stays pending and reconciliation will
      // poll it to a definitive outcome.
      return { status: "pending", providerReference: request.reference };
    }

    let parsed: PaystackTransferResponse;

    try {
      parsed = JSON.parse(response.body) as PaystackTransferResponse;
    } catch {
      // Uncertainty again: the request may have landed provider-side.
      return { status: "pending", providerReference: request.reference };
    }

    if (
      (response.status !== 200 && response.status !== 201) ||
      parsed.status !== true ||
      typeof parsed.data?.transfer_code !== "string"
    ) {
      return {
        status: "failed",
        providerReference: null,
        reason:
          typeof parsed.message === "string" && parsed.message.length > 0
            ? `Paystack rejected the transfer: ${parsed.message.slice(0, 300)}`
            : "Paystack rejected the transfer.",
      };
    }

    return {
      status: "pending",
      providerReference: parsed.data.transfer_code,
    };
  }

  // -------------------------------------------------------------------------
  // Transfer status — GET /transfer/verify/:reference (Stage 14C)
  // -------------------------------------------------------------------------

  async getTransferStatus(request: TransferStatusRequest): Promise<TransferStatusResult> {
    let response: { status: number; body: string };

    try {
      response = await withTimeout(
        paystackFetch(
          this.config.baseUrl,
          `/transfer/verify/${encodeURIComponent(request.providerReference)}`,
          this.config.secretKey,
          { method: "GET" },
          this.fetchImpl,
        ),
      );
    } catch {
      return { status: "unknown", reason: "provider_unavailable: Paystack could not be reached for transfer status." };
    }

    let parsed: PaystackTransferResponse;

    try {
      parsed = JSON.parse(response.body) as PaystackTransferResponse;
    } catch {
      return { status: "unknown", reason: "Paystack returned a malformed transfer status response." };
    }

    if (response.status !== 200 || parsed.status !== true || !parsed.data) {
      return { status: "unknown", reason: "Paystack could not resolve this transfer reference." };
    }

    switch (parsed.data.status) {
      case "success":
        return { status: "success", providerReference: request.providerReference };
      case "failed":
        return { status: "failed", providerReference: request.providerReference };
      case "reversed":
        return { status: "reversed", providerReference: request.providerReference };
      case "otp":
      case "pending":
      default:
        return { status: "pending", providerReference: request.providerReference };
    }
  }

  // -------------------------------------------------------------------------
  // Declared-but-unimplemented seam (deferred beyond 14C) — explicit failure,
  // never a silent success.
  // -------------------------------------------------------------------------

  async createRefund(_request: RefundRequest): Promise<RefundResult> {
    return { status: "failed", providerReference: null, reason: "Refunds are not implemented yet." };
  }
}

/**
 * Configure the global provider singleton when Paystack is configured;
 * a no-op in dormant mode (webhook route answers 503, fail closed).
 * Must be called from a server-only bootstrap before the first payment call.
 */
export function configurePaystackProviderIfConfigured(overrides?: {
  fetchImpl?: PaystackFetch;
  resolveAdvertiserEmail?: (advertiserId: string) => Promise<string | null>;
}): boolean {
  const config = getPaystackConfig();

  if (!config) {
    return false;
  }

  if (!hasPaymentProvider()) {
    configurePaymentProvider(
      new PaystackProvider(
        config,
        overrides?.fetchImpl,
        overrides?.resolveAdvertiserEmail,
      ),
    );
  }

  return true;
}
