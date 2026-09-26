-- Stage 14C - creator payouts.
-- Additive only: new enums, new tables, one new nullable column on
-- PaymentProviderTransaction, new FKs and indexes. No existing table, column
-- or enum is modified or dropped. No data reset.
--
-- Payout design (see schema comments):
--   CreatorPayoutRecipient — the creator's payout destination. Recipient codes
--     are created SERVER-SIDE via the provider port; a client can never
--     supply one. Only the provider's code + its verified account name are
--     stored; raw bank-account numbers are deliberately not persisted.
--   CreatorPayout — the LOGICAL payout, exactly one per milestone (unique
--     milestoneId), with a deterministic payoutRef. Distinct from provider
--     attempts, which live in PaymentProviderTransaction (milestoneId-scoped)
--     and each carry their own unique provider reference; a definitive
--     failure never reuses a reference — the next attempt gets a new one.

CREATE TYPE "PayoutRecipientStatus" AS ENUM ('ACTIVE', 'RETIRED');

CREATE TYPE "CreatorPayoutStatus" AS ENUM ('PENDING', 'PROCESSING', 'PAID', 'FAILED', 'REVERSAL_RECEIVED');

-- The creator's payout destination (server-owned; no raw bank data stored).
CREATE TABLE "CreatorPayoutRecipient" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "recipientCode" TEXT NOT NULL,
    "accountName" TEXT,
    "status" "PayoutRecipientStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorPayoutRecipient_pkey" PRIMARY KEY ("id")
);

-- The LOGICAL creator payout for one milestone (exactly one per milestone).
CREATE TABLE "CreatorPayout" (
    "id" TEXT NOT NULL,
    "milestoneId" TEXT NOT NULL,
    "agreementId" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "payoutRef" TEXT NOT NULL,
    "status" "CreatorPayoutStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastProviderReference" TEXT,
    "paidAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "reversedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorPayout_pkey" PRIMARY KEY ("id")
);

-- Per-milestone scoping for provider transfer attempts (evidence rows).
ALTER TABLE "PaymentProviderTransaction" ADD COLUMN "milestoneId" TEXT;

ALTER TABLE "PaymentProviderTransaction" ADD CONSTRAINT "PaymentProviderTransaction_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "Milestone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "CreatorPayoutRecipient_creatorId_provider_currency_status_key" ON "CreatorPayoutRecipient"("creatorId", "provider", "currency", "status");
CREATE INDEX "CreatorPayoutRecipient_creatorId_idx" ON "CreatorPayoutRecipient"("creatorId");

CREATE UNIQUE INDEX "CreatorPayout_milestoneId_key" ON "CreatorPayout"("milestoneId");
CREATE UNIQUE INDEX "CreatorPayout_payoutRef_key" ON "CreatorPayout"("payoutRef");
CREATE INDEX "CreatorPayout_status_idx" ON "CreatorPayout"("status");
CREATE INDEX "CreatorPayout_creatorId_idx" ON "CreatorPayout"("creatorId");

CREATE INDEX "PaymentProviderTransaction_milestoneId_idx" ON "PaymentProviderTransaction"("milestoneId");

-- AddForeignKey
ALTER TABLE "CreatorPayoutRecipient" ADD CONSTRAINT "CreatorPayoutRecipient_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CreatorPayout" ADD CONSTRAINT "CreatorPayout_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "Milestone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
