-- Agenda Managed (V1, slice 4) — internal outreach tracking for sourcing
-- candidates. Additive only: one new enum, one new table, one FK, one unique
-- constraint, one index. No existing table, column or enum is modified and
-- nothing is dropped.
--
-- This is an INTERNAL tracking workflow only: no code path in this slice
-- sends an email, DM, SMS or any other external communication. Support
-- records off-platform outreach and the creator's response.
--
-- Exactly one record per candidate: candidateId is @unique, so the database
-- itself rejects a duplicate "mark contacted" (a lost pre-check race fails
-- here instead of creating a second record). No row for a candidate means
-- "not yet contacted".
--
-- Rows are SUPPORT-ONLY data behind the Stage 14D seam. No advertiser- or
-- creator-facing read path selects this table: advertisers never see notes
-- or raw outreach records, and creators have no access in this slice.

CREATE TYPE "ManagedBriefOutreachStatus" AS ENUM ('CONTACTED', 'INTERESTED', 'DECLINED');

CREATE TABLE "ManagedBriefCandidateOutreach" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "status" "ManagedBriefOutreachStatus" NOT NULL DEFAULT 'CONTACTED',
    "contactedAt" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3),
    "note" TEXT,
    "contactedById" TEXT NOT NULL,
    "respondedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagedBriefCandidateOutreach_pkey" PRIMARY KEY ("id")
);

-- Exactly one outreach record per sourcing candidate.
CREATE UNIQUE INDEX "ManagedBriefCandidateOutreach_candidateId_key"
    ON "ManagedBriefCandidateOutreach"("candidateId");

-- The record belongs to its candidate. Cascade: deleting the candidate (or
-- its brief/creator/account) takes the internal outreach row with it.
ALTER TABLE "ManagedBriefCandidateOutreach"
    ADD CONSTRAINT "ManagedBriefCandidateOutreach_candidateId_fkey"
    FOREIGN KEY ("candidateId") REFERENCES "ManagedBriefSourcingCandidate"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "ManagedBriefCandidateOutreach_status_idx" ON "ManagedBriefCandidateOutreach"("status");
