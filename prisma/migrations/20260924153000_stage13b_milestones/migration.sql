-- Stage 13B - milestone review, correction & payment release.
-- Additive only: two new enums, two new tables, one new column on
-- PlatformFeeConfig, one new FK pair and indexes. Nothing existing is dropped
-- except the superseded (currency, status) unique index on PlatformFeeConfig,
-- replaced by (currency, feeType, status) which still guarantees at most one
-- ACTIVE configuration per currency and fee type. No data reset.

CREATE TYPE "FeeConfigType" AS ENUM ('AGREEMENT_FUNDING', 'MILESTONE_ADVERTISER_FEE', 'MILESTONE_CREATOR_FEE');
CREATE TYPE "MilestoneStatus" AS ENUM ('PENDING', 'VERIFIED_PENDING_REVIEW', 'CORRECTION_REQUESTED', 'PENDING_REVERIFICATION', 'SUPPORT_REVIEW', 'CONFIRMED_RELEASE', 'SETTLEMENT_PENDING', 'RELEASED', 'VALID_CANCELLATION');
CREATE TYPE "SupportDecisionType" AS ENUM ('RELEASE_PAYMENT', 'REQUEST_CORRECTION', 'CANCEL_AFFECTED_WORK', 'FURTHER_REVIEW');
CREATE TYPE "MilestoneEventType" AS ENUM ('milestone_defined', 'post_submitted', 'verification_verified', 'verification_rejected', 'review_window_opened', 'review_timer_paused', 'review_timer_resumed', 'advertiser_delay_recorded', 'correction_requested', 'correction_submitted', 'confirmed_release', 'settlement_requested', 'released', 'escalated_support', 'support_decision', 'cancelled_valid');

-- Fee configuration becomes typed: funding fee, milestone advertiser service
-- fee and milestone creator commission are configured independently. Existing
-- rows default to AGREEMENT_FUNDING, preserving their original meaning.
ALTER TABLE "PlatformFeeConfig" ADD COLUMN "feeType" "FeeConfigType" NOT NULL DEFAULT 'AGREEMENT_FUNDING';

-- The old (currency, status) unique index allowed exactly one config per
-- currency; the new one allows one per (currency, feeType). It is recreated
-- below under its new name after the old one is removed.
DROP INDEX "PlatformFeeConfig_currency_status_key";

-- One milestone of a (multi-)deliverable agreement. Amounts are frozen
-- server-side ONCE from the frozen agreement terms; client input can never
-- write any money column on this row.
CREATE TABLE "Milestone" (
    "id" TEXT NOT NULL,
    "agreementId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "advertiserId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "milestoneRef" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "deliverables" TEXT,
    "creatorAmountMinor" BIGINT NOT NULL,
    "advertiserServiceFeeMinor" BIGINT NOT NULL,
    "creatorCommissionMinor" BIGINT NOT NULL,
    "advertiserTotalMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "advertiserFeeConfigId" TEXT,
    "creatorFeeConfigId" TEXT,
    "status" "MilestoneStatus" NOT NULL DEFAULT 'PENDING',
    "paidPostId" TEXT,
    "reviewWindowOpenedAt" TIMESTAMP(3),
    "reviewWindowDeadlineAt" TIMESTAMP(3),
    "reviewPausedAt" TIMESTAMP(3),
    "totalPausedSeconds" INTEGER NOT NULL DEFAULT 0,
    "correctionCount" INTEGER NOT NULL DEFAULT 0,
    "correctionRequestedAt" TIMESTAMP(3),
    "correctionRequestedBy" TEXT,
    "correctionRequestNote" TEXT,
    "correctionSubmittedAt" TIMESTAMP(3),
    "correctionSubmittedBy" TEXT,
    "advertiserConfirmedAt" TIMESTAMP(3),
    "advertiserConfirmedBy" TEXT,
    "supportEscalatedAt" TIMESTAMP(3),
    "supportEscalatedBy" TEXT,
    "supportEscalationReason" TEXT,
    "supportDecidedAt" TIMESTAMP(3),
    "supportDecisionById" TEXT,
    "supportDecision" "SupportDecisionType",
    "supportDecisionNote" TEXT,
    "releasedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Milestone_pkey" PRIMARY KEY ("id")
);

-- Append-only milestone audit trail; duplicates rejected by idempotencyKey.
CREATE TABLE "MilestoneEvent" (
    "id" TEXT NOT NULL,
    "milestoneId" TEXT NOT NULL,
    "agreementId" TEXT NOT NULL,
    "eventType" "MilestoneEventType" NOT NULL,
    "actor" TEXT NOT NULL,
    "actorId" TEXT,
    "source" TEXT NOT NULL,
    "details" JSONB,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MilestoneEvent_pkey" PRIMARY KEY ("id")
);

-- Additive FKs. RESTRICT so milestone history can never disappear with its
-- agreement, and a post that represents a milestone can never be hard-deleted
-- underneath it (SetNull keeps the milestone and its audit trail intact).
ALTER TABLE "Milestone"
    ADD CONSTRAINT "Milestone_agreementId_fkey"
    FOREIGN KEY ("agreementId") REFERENCES "CampaignAgreement"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Milestone"
    ADD CONSTRAINT "Milestone_paidPostId_fkey"
    FOREIGN KEY ("paidPostId") REFERENCES "CampaignPost"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MilestoneEvent"
    ADD CONSTRAINT "MilestoneEvent_milestoneId_fkey"
    FOREIGN KEY ("milestoneId") REFERENCES "Milestone"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Uniqueness + idempotency backstops.
CREATE UNIQUE INDEX "PlatformFeeConfig_currency_feeType_status_key" ON "PlatformFeeConfig"("currency", "feeType", "status");
CREATE UNIQUE INDEX "Milestone_agreementId_position_key" ON "Milestone"("agreementId", "position");
CREATE UNIQUE INDEX "Milestone_milestoneRef_key" ON "Milestone"("milestoneRef");
CREATE UNIQUE INDEX "Milestone_paidPostId_key" ON "Milestone"("paidPostId");
CREATE UNIQUE INDEX "MilestoneEvent_idempotencyKey_key" ON "MilestoneEvent"("idempotencyKey");

-- Auditability/query indexes.
CREATE INDEX "Milestone_status_idx" ON "Milestone"("status");
CREATE INDEX "Milestone_advertiserId_idx" ON "Milestone"("advertiserId");
CREATE INDEX "Milestone_creatorId_idx" ON "Milestone"("creatorId");
CREATE INDEX "Milestone_agreementId_idx" ON "Milestone"("agreementId");
CREATE INDEX "MilestoneEvent_milestoneId_createdAt_idx" ON "MilestoneEvent"("milestoneId", "createdAt");
CREATE INDEX "MilestoneEvent_agreementId_idx" ON "MilestoneEvent"("agreementId");
CREATE INDEX "MilestoneEvent_eventType_idx" ON "MilestoneEvent"("eventType");

-- ---------------------------------------------------------------------------
-- Seed the locked Stage 13B fee configuration (explicit operational decision,
-- exactly as the 13A design intended: the system never invents a fee). The
-- 5% advertiser milestone service fee and 10% creator marketplace commission
-- are EARNED only when the corresponding milestone completes/settles — never
-- for future or validly-cancelled milestones.
-- ---------------------------------------------------------------------------
INSERT INTO "PlatformFeeConfig" ("id", "feeBasisPoints", "currency", "feeType", "status", "note", "effectiveFrom", "createdAt", "updatedAt")
VALUES (
    'seed-fee-adv-500-ngn', 500, 'NGN', 'MILESTONE_ADVERTISER_FEE', 'ACTIVE',
    'Stage 13B locked rules: 5% advertiser service fee per completed milestone.',
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
), (
    'seed-fee-creator-1000-ngn', 1000, 'NGN', 'MILESTONE_CREATOR_FEE', 'ACTIVE',
    'Stage 13B locked rules: 10% creator marketplace commission per completed milestone.',
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
