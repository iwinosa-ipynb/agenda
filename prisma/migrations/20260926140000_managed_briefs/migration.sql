-- Agenda Managed (V1, slice 1) — private managed-marketing briefs.
-- Additive only: one new enum, one new table, one new FK, indexes. No
-- existing table, column or enum is modified and nothing is dropped.
--
-- Briefs are PRIVATE advertiser submissions: never visible to creators, never
-- listed publicly. Advertiser access is ownership-scoped in the service layer
-- (advertiserId in every where-clause); support reads go through the Stage 14D
-- trusted-operator seam (role + support roster). No creator-facing or
-- financial object is derived from a brief in this slice.

CREATE TYPE "ManagedBriefStatus" AS ENUM ('SUBMITTED', 'IN_REVIEW', 'CLOSED');

CREATE TABLE "ManagedBrief" (
    "id" TEXT NOT NULL,
    "advertiserId" TEXT NOT NULL,
    "campaignGoal" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "budgetMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "targetAudience" TEXT NOT NULL,
    "targetPlatforms" TEXT[] NOT NULL,
    "creatorRequirements" TEXT,
    "status" "ManagedBriefStatus" NOT NULL DEFAULT 'SUBMITTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagedBrief_pkey" PRIMARY KEY ("id")
);

-- The brief belongs to its advertiser. Cascade matches the profile cascade
-- used by the advertiser's other owned records (campaigns, agreements).
ALTER TABLE "ManagedBrief"
    ADD CONSTRAINT "ManagedBrief_advertiserId_fkey"
    FOREIGN KEY ("advertiserId") REFERENCES "AdvertiserProfile"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Advertiser-scoped reads (list "my briefs") and the ops review queue.
CREATE INDEX "ManagedBrief_advertiserId_idx" ON "ManagedBrief"("advertiserId");
CREATE INDEX "ManagedBrief_status_idx" ON "ManagedBrief"("status");
