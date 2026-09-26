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
  type RefundStatusRequest,
  type RefundStatusResult,
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

// Stage 14E — shape of the POST /refund response (status:true + queued
// message on success; data.status moves pending → processing → processed).
type PaystackRefundResponse = {
  status: boolean;
  message: string;
  data?: { id?: number; status?: string; amount?: number; currency?: string };
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

  /**
 * Stage 14E — refund execution. The port contract predates this adapter
 * (declared in Stage 13A) and is unchanged.
 *
 * Official Paystack Refund API (verified against paystack.com/docs/api/refund,
 * September 2026):
 *   - POST /refund — body: transaction (reference or id), amount (optional,
 *     integer subunit), currency, customer_note, merchant_note. There is NO
 *     client-supplied "reference" field; Paystack generates its own refund id.
 *   - The create call is ASYNCHRONOUS: success is 200 with
 *     {status:true, message:"Refund has been queued for processing", data
 *     with refund status "pending"}. The refund object's status then moves
 *     through processing to "processed" (visible via GET /refund/:id).
 *
 * Mapping rules (money-moving POST safety conventions, matching createPayout):
 *   - 200/201 with status:true and a processed/failed refund status → the
 *     DEFINITIVE outcome the provider stated ("processed" only from the
 *     provider's own processed marker — never inferred);
 *   - 200/201 with status:true and a queued/processing/unknown status →
 *     "pending" (the refund is in flight provider-side, not yet definitive);
 *   - HTTP 4xx/5xx, status:false, or a malformed body → "failed" (the
 *     provider explicitly rejected the request — nothing was queued);
 *   - network error / timeout → "pending" (the request may or may not have
 *     landed provider-side: uncertainty is never converted into failure or
 *     success).
 */
async createRefund(request: RefundRequest): Promise<RefundResult> {
  let response: { status: number; body: string };

  try {
    response = await withTimeout(
      paystackFetch(
        this.config.baseUrl,
        "/refund",
        this.config.secretKey,
        {
          method: "POST",
          // Only documented fields are sent. `transaction` carries the charge's
          // Paystack transaction reference (the access code captured on the
          // attempt row at initiation). amount: INTEGER SUBUNIT as a
          // string-safe number: BigInt → string, never a float. The refund
          // amount is validated against the frozen obligation by the SERVICE
          // layer — the adapter never enlarges or shrinks it.
          body: JSON.stringify({
            transaction: request.providerReference,
            amount: request.amountMinor.toString(),
            currency: request.currency,
            merchant_note: `Agenda refund ${request.reference}`,
          }),
        },
        this.fetchImpl,
      ),
    );
  } catch {
    // Uncertainty, not failure: the request may or may not have landed
    // provider-side, so the caller keeps the obligation REFUND_PENDING and
    // a later retry/evidence path converges.
    return { status: "pending", providerReference: request.reference };
  }

  let parsed: PaystackRefundResponse;

  try {
    parsed = JSON.parse(response.body) as PaystackRefundResponse;
  } catch {
    // A malformed envelope is an explicit error, never a success (the caller
    // keeps the obligation REFUND_PENDING — an audited, retryable state — so
    // this can never silently drop a refund that actually landed).
    return {
      status: "failed",
      providerReference: null,
      reason: "Paystack returned a malformed refund response.",
    };
  }

  if (
    (response.status !== 200 && response.status !== 201) ||
    parsed.status !== true ||
    typeof parsed.data?.status !== "string"
  ) {
    return {
      status: "failed",
      providerReference: null,
      reason:
        typeof parsed.message === "string" && parsed.message.length > 0
          ? `Paystack rejected the refund: ${parsed.message.slice(0, 300)}`
          : "Paystack rejected the refund.",
    };
  }

  // Only the provider's own processed marker is definitive success.
  if (parsed.data.status === "processed") {
    return {
      status: "processed",
      providerReference: String(parsed.data.id),
    };
  }

  if (parsed.data.status === "failed") {
    return {
      status: "failed",
      providerReference: String(parsed.data.id ?? ""),
      reason: "Paystack reports the refund as failed.",
  };
  }

  // pending / processing / unknown provider status → queued, in flight.
  // data.id is Paystack's refund identity: the service persists it on the
  // attempt row so reconciliation can target GET /refund/:id later.
  return { status: "pending", providerReference: String(parsed.data.id) };
}

  // -------------------------------------------------------------------------
  // Refund status — GET /refund/:id, fallback GET /refund?transaction=...
  // (Stage 14E safety fix)
  // -------------------------------------------------------------------------

  /**
   * Stage 14E — provider refund-status lookup.
   *
   * Official Paystack Refund API (paystack.com/docs/api/refund):
   *   - GET /refund/:id — fetch one refund by Paystack's own refund id;
   *   - GET /refund?transaction=<id> — list refunds for a transaction (used
   *     only when no refund id was persisted, e.g. a crash lost the id).
   *
   * Mapping rules:
   *   - data.status "processed" → "processed" (the provider's own marker);
   *   - data.status "failed" → "failed";
   *   - pending/processing/anything else → "pending" (in flight);
   *   - HTTP/parse/network errors → "unknown" (NEVER "failed": an unanswerable
   *     lookup must never license a re-POST of the money-moving endpoint).
   */
  async getRefundStatus(request: RefundStatusRequest): Promise<RefundStatusResult> {
    const byId =
      typeof request.providerRefundId === "string" && request.providerRefundId.length > 0
        ? await this.fetchRefundStatus(`/refund/${encodeURIComponent(request.providerRefundId)}`)
        : null;

    if (byId === "error") {
      // A targeted lookup EXISTS but failed: do not silently widen the search —
      // the caller must fail closed rather than re-POST.
      return { status: "unknown", reason: "Paystack could not be reached for the refund status." };
    }

    if (byId !== null) {
      return byId;
    }

    // No persisted refund id: list refunds for the charge (transaction id or
    // reference both accepted by the endpoint). Empty list → the provider
    // confirms no refund exists (a definitive "failed"-shaped outcome: the
    // only state in which the service may POST once).
    const listed = await this.fetchRefundStatus(
      `/refund?transaction=${encodeURIComponent(request.chargeReference)}`,
    );

    if (listed === "error") {
      return { status: "unknown", reason: "Paystack could not be reached for the refund status." };
    }

    return listed;
  }

  /** Shared GET for both refund-status shapes; "error" marks transport failure. */
  private async fetchRefundStatus(
    path: string,
  ): Promise<RefundStatusResult | "error"> {
    let response: { status: number; body: string };

    try {
      response = await withTimeout(
        paystackFetch(
          this.config.baseUrl,
          path,
          this.config.secretKey,
          { method: "GET" },
          this.fetchImpl,
        ),
      );
    } catch {
      return "error";
    }

    let parsed: { status: boolean; message: string; data?: unknown };

    try {
      parsed = JSON.parse(response.body) as {
        status: boolean;
        message: string;
        data?: unknown;
      };
    } catch {
      return "error";
    }

    if (response.status !== 200 || parsed.status !== true) {
      return "error";
    }

    // GET /refund/:id → object; GET /refund?transaction= → array (list).
    const candidates: Array<Record<string, unknown>> = Array.isArray(parsed.data)
      ? (parsed.data as Array<Record<string, unknown>>)
      : parsed.data && typeof parsed.data === "object"
        ? [parsed.data as Record<string, unknown>]
        : [];

    if (candidates.length === 0) {
      // Provider confirms: no refund exists for this charge.
      return { status: "failed", providerRefundId: null };
    }

    // Multiple refund objects can exist for one transaction: answer with the
    // SAFEST aggregate — any in-flight refund wins (never re-POST past a
    // pending), then any processed (finalizable), else failed/missing.
    let processedId: string | null = null;

    for (const refund of candidates) {
      const rawStatus = typeof refund.status === "string" ? refund.status : "";
      const refundId =
        typeof refund.id === "number" && Number.isInteger(refund.id) ? String(refund.id) : null;

      if (rawStatus !== "processed" && rawStatus !== "failed") {
        // pending / processing / unknown → in flight.
        return { status: "pending", providerRefundId: refundId };
      }

      if (rawStatus === "processed" && processedId === null) {
        processedId = refundId;
      }
    }

    if (processedId !== null) {
      return { status: "processed", providerRefundId: processedId };
    }

    // Every candidate is definitively failed → no live refund.
    return { status: "failed", providerRefundId: null };
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
