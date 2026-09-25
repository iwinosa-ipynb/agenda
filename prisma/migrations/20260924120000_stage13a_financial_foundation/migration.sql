-- Stage 13A - financial foundation.
-- Additive only: new enums, new tables, new FKs. No existing table, column or
-- enum is modified and nothing is dropped. No data reset.

CREATE TYPE "FinancialObligationStatus" AS ENUM ('PENDING_PAYMENT', 'PROCESSING', 'FUNDED', 'SETTLEMENT_PENDING', 'RELEASED', 'REFUNDED', 'REFUND_PENDING', 'FAILED', 'DISPUTED', 'CANCELLED');
CREATE TYPE "LedgerDirection" AS ENUM ('DEBIT', 'CREDIT');
CREATE TYPE "LedgerEntryType" AS ENUM ('CHARGE', 'ESCROW_HOLD', 'PLATFORM_FEE', 'CREATOR_PAYOUT', 'REFUND', 'ADJUSTMENT', 'FEE_REFUND');
CREATE TYPE "FinancialEventType" AS ENUM ('obligation_created', 'payment_initiated', 'payment_verified', 'payment_failed', 'escrow_funded', 'settlement_requested', 'settlement_completed', 'refund_requested', 'refund_completed', 'payout_created', 'payout_completed', 'payout_failed', 'payout_reversed', 'dispute_opened', 'dispute_resolved', 'admin_adjustment');
CREATE TYPE "FinancialEventActor" AS ENUM ('SYSTEM', 'ADVERTISER', 'CREATOR', 'ADMIN', 'PROVIDER');
CREATE TYPE "WebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'SKIPPED');
CREATE TYPE "ProviderTransactionStatus" AS ENUM ('PENDING', 'REQUIRES_ACTION', 'SUCCEEDED', 'FAILED', 'REVERSED', 'REFUNDED', 'UNKNOWN');
CREATE TYPE "FinancialActorRole" AS ENUM ('SYSTEM', 'ADVERTISER', 'CREATOR', 'ADMIN');
CREATE TYPE "FeeConfigStatus" AS ENUM ('ACTIVE', 'RETIRED');

-- The one-to-one financial object derived from a Stage 12 CampaignAgreement.
-- Amounts are copied ONCE, server-side, from the agreement and then frozen.
CREATE TABLE "FinancialObligation" (
    "id" TEXT NOT NULL,
    "agreementId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "advertiserId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "creatorAmountMinor" BIGINT NOT NULL,
    "platformFeeMinor" BIGINT NOT NULL,
    "advertiserTotalMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "FinancialObligationStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "obligationRef" TEXT NOT NULL,
    "escrowFunded" BOOLEAN NOT NULL DEFAULT false,
    "dispute" BOOLEAN NOT NULL DEFAULT false,
    "disputeReason" TEXT,
    "feeConfigId" TEXT,
    "providerReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancialObligation_pkey" PRIMARY KEY ("id")
);

-- Append-only ledger. Rows are never updated or deleted; corrections are
-- compensating entries. The idempotencyKey unique constraint is the database
-- backstop for exactly-once entry writes.
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "entryType" "LedgerEntryType" NOT NULL,
    "agreementId" TEXT,
    "financialObligationId" TEXT,
    "financialEventId" TEXT,
    "providerReference" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- Append-only record of WHY an obligation changed state.
CREATE TABLE "FinancialEvent" (
    "id" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "agreementId" TEXT NOT NULL,
    "eventType" "FinancialEventType" NOT NULL,
    "actor" "FinancialEventActor" NOT NULL,
    "actorId" TEXT,
    "source" TEXT NOT NULL,
    "metadata" JSONB,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinancialEvent_pkey" PRIMARY KEY ("id")
);

-- Provider-side transaction snapshots (evidence, not authority).
CREATE TABLE "PaymentProviderTransaction" (
    "id" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerReference" TEXT NOT NULL,
    "providerStatus" "ProviderTransactionStatus" NOT NULL DEFAULT 'PENDING',
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "metadata" JSONB,
    "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentProviderTransaction_pkey" PRIMARY KEY ("id")
);

-- Stored provider webhooks; deduplicated by (provider, providerEventId).
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT,
    "eventType" TEXT,
    "payload" JSONB NOT NULL,
    "signatureMetadata" JSONB,
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "processingError" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- Server-side platform fee configuration. Unset by default: with no ACTIVE
-- row the system refuses payment processing (FEE_NOT_CONFIGURED) - it never
-- invents a fee and never defaults silently to 0.
CREATE TABLE "PlatformFeeConfig" (
    "id" TEXT NOT NULL,
    "feeBasisPoints" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "FeeConfigStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformFeeConfig_pkey" PRIMARY KEY ("id")
);

-- Additive FKs. The obligation-to-agreement link is RESTRICT so a financial
-- record can never disappear with its agreement.
ALTER TABLE "FinancialObligation"
    ADD CONSTRAINT "FinancialObligation_agreementId_fkey"
    FOREIGN KEY ("agreementId") REFERENCES "CampaignAgreement"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FinancialEvent"
    ADD CONSTRAINT "FinancialEvent_obligationId_fkey"
    FOREIGN KEY ("obligationId") REFERENCES "FinancialObligation"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LedgerEntry"
    ADD CONSTRAINT "LedgerEntry_financialObligationId_fkey"
    FOREIGN KEY ("financialObligationId") REFERENCES "FinancialObligation"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaymentProviderTransaction"
    ADD CONSTRAINT "PaymentProviderTransaction_obligationId_fkey"
    FOREIGN KEY ("obligationId") REFERENCES "FinancialObligation"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- One obligation per agreement: the database enforces 1:1, so concurrent
-- creation attempts cannot both succeed.
CREATE UNIQUE INDEX "FinancialObligation_agreementId_key" ON "FinancialObligation"("agreementId");
CREATE UNIQUE INDEX "FinancialObligation_obligationRef_key" ON "FinancialObligation"("obligationRef");

-- Append-only integrity + idempotency: one row per key, ever.
CREATE UNIQUE INDEX "LedgerEntry_idempotencyKey_key" ON "LedgerEntry"("idempotencyKey");
CREATE UNIQUE INDEX "FinancialEvent_idempotencyKey_key" ON "FinancialEvent"("idempotencyKey");
CREATE UNIQUE INDEX "PaymentProviderTransaction_provider_providerReference_key" ON "PaymentProviderTransaction"("provider", "providerReference");
CREATE UNIQUE INDEX "WebhookEvent_provider_providerEventId_key" ON "WebhookEvent"("provider", "providerEventId");
-- Exactly one ACTIVE fee configuration per currency.
CREATE UNIQUE INDEX "PlatformFeeConfig_currency_status_key" ON "PlatformFeeConfig"("currency", "status");

-- Auditability/query indexes.
CREATE INDEX "FinancialObligation_status_idx" ON "FinancialObligation"("status");
CREATE INDEX "FinancialObligation_advertiserId_idx" ON "FinancialObligation"("advertiserId");
CREATE INDEX "FinancialObligation_creatorId_idx" ON "FinancialObligation"("creatorId");
CREATE INDEX "FinancialObligation_campaignId_idx" ON "FinancialObligation"("campaignId");
CREATE INDEX "LedgerEntry_financialObligationId_createdAt_idx" ON "LedgerEntry"("financialObligationId", "createdAt");
CREATE INDEX "LedgerEntry_account_createdAt_idx" ON "LedgerEntry"("account", "createdAt");
CREATE INDEX "LedgerEntry_entryType_idx" ON "LedgerEntry"("entryType");
CREATE INDEX "LedgerEntry_agreementId_idx" ON "LedgerEntry"("agreementId");
CREATE INDEX "FinancialEvent_obligationId_createdAt_idx" ON "FinancialEvent"("obligationId", "createdAt");
CREATE INDEX "FinancialEvent_agreementId_idx" ON "FinancialEvent"("agreementId");
CREATE INDEX "FinancialEvent_eventType_idx" ON "FinancialEvent"("eventType");
CREATE INDEX "PaymentProviderTransaction_obligationId_idx" ON "PaymentProviderTransaction"("obligationId");
CREATE INDEX "PaymentProviderTransaction_provider_providerStatus_idx" ON "PaymentProviderTransaction"("provider", "providerStatus");
CREATE INDEX "WebhookEvent_status_receivedAt_idx" ON "WebhookEvent"("status", "receivedAt");
CREATE INDEX "WebhookEvent_provider_eventType_idx" ON "WebhookEvent"("provider", "eventType");
