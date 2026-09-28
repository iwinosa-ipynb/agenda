-- Creator Opportunity Matching + Notifications (V1).
--
-- Matching is a RELEVANCE system, not eligibility: an opportunity record
-- means "this published campaign shares attributes with this creator", never
-- "this creator can apply" — applyToCampaign remains the single authoritative
-- application gate and matching NEVER applies anyone. One row per
-- (campaign, creator): the DB unique constraint is the dedupe arbiter so a
-- re-run or raced publication can never double-notify.
--
-- Visibility discipline: rows are created ONLY by the server-side publication
-- flow, for PUBLISHED campaigns that satisfy the marketplace's own
-- open-listing visibility rules. A creator therefore never receives an
-- opportunity for a campaign they could not legally see, and no client input
-- can create one.
--
-- Additive only: one new table, two relation backhauls via FK. No existing
-- table, column or enum is modified and nothing is dropped.

CREATE TABLE "CreatorOpportunityNotification" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "reasons" TEXT[] NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorOpportunityNotification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CreatorOpportunityNotification_campaignId_creatorId_key"
    ON "CreatorOpportunityNotification"("campaignId", "creatorId");

CREATE INDEX "CreatorOpportunityNotification_creatorId_readAt_idx"
    ON "CreatorOpportunityNotification"("creatorId", "readAt");

ALTER TABLE "CreatorOpportunityNotification"
    ADD CONSTRAINT "CreatorOpportunityNotification_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CreatorOpportunityNotification"
    ADD CONSTRAINT "CreatorOpportunityNotification_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "CreatorProfile"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
