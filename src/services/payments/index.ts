/**
 * Stage 13A — payment provider port (provider-agnostic abstraction).
 *
 * This module defines the ONLY seam through which provider-specific payment
 * logic may enter the application. Paystack details live behind
 * implementations of `PaymentProvider`, never in services or routes.
 *
 * Stage 13A intentionally implements NO live provider behavior: no charge
 * endpoints are called, no transfers or refunds are executed, no production
 * keys are required. Everything below is the interface future stages (13B+)
 * will implement.
 *
 * All amounts are BigInt integers in MINOR UNITS (kobo for NGN: ₦1,000.00 =
 * 100000) — never floats, never client-supplied.
 */

import type { ProviderTransactionStatus } from "@/generated/prisma/client";

export type ChargeRequest = {
  advertiserId: string;
  campaignId: string;
  /** Amount in the smallest currency unit, computed server-side. */
  amountMinor: bigint;
  currency: string;
  /** Obligation-scoped deterministic reference. */
  reference: string;
};

export type ChargeResult =
  | { status: "requires_action"; providerReference: string; redirectUrl: string }
  | { status: "succeeded"; providerReference: string }
  | { status: "failed"; providerReference: string | null; reason: string };

/** Server-side verification of a provider transaction (the FUNDED gate). */
export type VerificationRequest = {
  providerReference: string;
  /** Expected amount — a verified amount that differs is a hard failure. */
  expectedAmountMinor: bigint;
  currency: string;
};

export type VerificationResult =
  | {
      status: "verified";
      providerReference: string;
      providerStatus: ProviderTransactionStatus;
      amountMinor: bigint;
      currency: string;
      paidAt: string | null;
      /** Raw, secret-free provider payload snapshot for audit. */
      raw?: Record<string, unknown>;
    }
  | { status: "unverified"; providerReference: string | null; reason: string };

/** Stage 13B will implement refunds; the port only fixes the shape. */
export type RefundRequest = {
  obligationId: string;
  providerReference: string;
  amountMinor: bigint;
  currency: string;
  reference: string;
};

export type RefundResult =
  | { status: "pending"; providerReference: string }
  | { status: "processed"; providerReference: string }
  | { status: "failed"; providerReference: string | null; reason: string };

export type PayoutRequest = {
  creatorId: string;
  amountMinor: bigint;
  currency: string;
  reference: string;
  /**
   * Stage 14C: the destination recipient code, resolved by the SERVICE layer
   * from its own server-owned recipient storage — never from client input,
   * never carried through a client-visible request.
   */
  recipientCode: string;
};

export type PayoutResult =
  | { status: "pending"; providerReference: string }
  | { status: "failed"; providerReference: string | null; reason: string };

/** Transfer (payout) status check — used by Stage 13B reconciliation. */
export type TransferStatusRequest = {
  providerReference: string;
};

export type TransferStatusResult =
  | { status: "pending" | "success" | "failed" | "reversed"; providerReference: string }
  | { status: "unknown"; reason: string };

/**
 * Recipient creation/verification for creator payouts (Stage 13B). Defined
 * here so the domain model exists, but NO recipient onboarding, bank-account
 * collection or KYC happens in Stage 13A.
 *
 * Stage 14C (approved minimal extension): the provider needs the creator's
 * bank details to create a transfer recipient — the port now carries them.
 * The provider adapter stays database-free: the SERVICE layer resolves the
 * details and passes them in; a client can never reach the provider with a
 * self-supplied recipient code because none is ever accepted as input.
 */
export type RecipientBankAccount = {
  /** Bank account number (digits), validated server-side before the call. */
  accountNumber: string;
  /** Provider bank identifier (e.g. Paystack bank_code), resolved server-side. */
  bankCode: string;
  /** Account-holder name as verified by the provider. */
  accountName: string;
};

export type RecipientRequest = {
  creatorId: string;
  currency: string;
  bankAccount: RecipientBankAccount;
};

export type RecipientResult =
  | { status: "created"; recipientCode: string }
  | { status: "failed"; reason: string };

/**
 * Normalized webhook envelope. Provider implementations translate their
 * native event shape into this before any Agenda logic sees it.
 */
export type NormalizedWebhookEvent = {
  /** Stable provider event identity used for database deduplication. */
  providerEventId: string | null;
  eventType: string | null;
  /** Parsed body, secret-free, as stored in WebhookEvent.payload. */
  payload: Record<string, unknown>;
};

export type WebhookVerificationRequest = {
  /** Raw request body bytes — signature checks must use raw bytes. */
  rawBody: string;
  headers: Record<string, string | null>;
};

export type WebhookVerificationResult =
  | { verified: true; event: NormalizedWebhookEvent }
  | { verified: false; reason: string };

export interface PaymentProvider {
  readonly name: string;

  // --- Stage 13A: interfaces only (no live behavior implemented) ---

  /** Initiate a charge for an obligation. Stage 13B wires this to the provider. */
  createCharge(request: ChargeRequest): Promise<ChargeResult>;

  /**
   * THE proof required before FUNDED: verify a transaction against the
   * provider. Never trust a client report or an unverified webhook alone.
   */
  verifyTransaction(request: VerificationRequest): Promise<VerificationResult>;

  // --- Stage 13B seams (declared, not implemented) ---

  createRefund(request: RefundRequest): Promise<RefundResult>;
  createPayout(request: PayoutRequest): Promise<PayoutResult>;
  getTransferStatus(request: TransferStatusRequest): Promise<TransferStatusResult>;
  createRecipient(request: RecipientRequest): Promise<RecipientResult>;

  /**
   * Verify a webhook's signature against raw bytes and normalize the event.
   * Implementations must FAIL CLOSED when secrets are not configured.
   */
  verifyWebhook(request: WebhookVerificationRequest): Promise<WebhookVerificationResult>;
}

/** Thrown when no payment provider is configured. */
export class PaymentsNotImplementedError extends Error {
  constructor() {
    super("No payment provider is configured yet.");
    this.name = "PaymentsNotImplementedError";
  }
}

let provider: PaymentProvider | null = null;

export function configurePaymentProvider(next: PaymentProvider): void {
  provider = next;
}

export function getPaymentProvider(): PaymentProvider {
  if (!provider) {
    throw new PaymentsNotImplementedError();
  }

  return provider;
}

export function hasPaymentProvider(): boolean {
  return provider !== null;
}

/** Test-only reset so unit tests can swap providers in isolation. */
export function resetPaymentProviderForTests(): void {
  provider = null;
}
