-- Agenda Managed (V1, slice 3) — support sourcing candidates.
-- Additive only: one new enum, one new table, three FKs, one unique
-- constraint, indexes. No existing table, column or enum is modified and
-- nothing is dropped.
--
-- A candidate REFERENCES existing creator identity data (CreatorProfile +
-- SocialAccount) — identity is never duplicated into this table. The
-- (brief, creator, account) triple is unique at the DATABASE level, so a
-- duplicate add cannot race past the service's pre-check: the lost race
-- fails on the constraint instead of creating a second row.
--
-- Rows are SUPPORT-ONLY data behind the Stage 14D seam (role + support
-- roster, re-read fresh from the database on every call). No
-- advertiser- or creator-facing read path selects them: advertisers never
-- see candidate notes or sourcing status, and creators have no read path
-- at all in this slice.

CREATE TYPE "ManagedBriefCandidateStatus" AS ENUM ('PROSPECT', 'CONTACTED', 'INTERESTED', 'DECLINED', 'SELECTED');

CREATE TABLE "ManagedBriefSourcingCandidate" (
    "id" TEXT NOT NULL,
    "briefId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "socialAccountId" TEXT NOT NULL,
    "status" "ManagedBriefCandidateStatus" NOT NULL DEFAULT 'PROSPECT',
    "note" TEXT,
    "addedById" TEXT NOT NULL,
    "statusUpdatedAt" TIMESTAMP(3),
    "statusUpdatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagedBriefSourcingCandidate_pkey" PRIMARY KEY ("id")
);

-- The candidate belongs to one brief. Cascade: a deleted brief takes its
-- (internal) candidate rows with it.
ALTER TABLE "ManagedBriefSourcingCandidate"
    ADD CONSTRAINT "ManagedBriefSourcingCandidate_briefId_fkey"
    FOREIGN KEY ("briefId") REFERENCES "ManagedBrief"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- The candidate references an existing creator profile. Cascade matches the
-- profile's cascade convention (accounts, rate card, payout recipients).
ALTER TABLE "ManagedBriefSourcingCandidate"
    ADD CONSTRAINT "ManagedBriefSourcingCandidate_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "CreatorProfile"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- The candidate pins ONE existing platform account — the identity anchor for
-- dedupe and display. Cascade: if the account row goes, the candidate entry
-- whose anchor it was goes with it.
ALTER TABLE "ManagedBriefSourcingCandidate"
    ADD CONSTRAINT "ManagedBriefSourcingCandidate_socialAccountId_fkey"
    FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- One candidate per (brief, creator, account) — the duplicate guard IS the
-- database, so a lost pre-check race cannot create a second row.
CREATE UNIQUE INDEX "ManagedBriefSourcingCandidate_briefId_creatorId_socialAccountId_key"
    ON "ManagedBriefSourcingCandidate"("briefId", "creatorId", "socialAccountId");

CREATE INDEX "ManagedBriefSourcingCandidate_briefId_idx" ON "ManagedBriefSourcingCandidate"("briefId");
CREATE INDEX "ManagedBriefSourcingCandidate_creatorId_idx" ON "ManagedBriefSourcingCandidate"("creatorId");
CREATE INDEX "ManagedBriefSourcingCandidate_status_idx" ON "ManagedBriefSourcingCandidate"("status");
