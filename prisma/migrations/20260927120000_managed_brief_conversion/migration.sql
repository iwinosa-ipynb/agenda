-- Agenda Managed (V1, slice 5) — SELECTED candidate → DRAFT campaign traceability.
-- Additive only: one nullable column, one FK, one unique index. No existing
-- table, column or enum is modified and nothing is dropped — every existing
-- Managed Brief / candidate row is preserved as-is (campaignId stays NULL).
--
-- A SELECTED candidate is converted to a marketplace Campaign by the brief's
-- owning advertiser. The candidate's status stays SELECTED (terminal): this
-- nullable link IS the conversion traceability, not a new status.
--
-- The UNIQUE constraint is the database-level race arbiter for conversion:
-- two concurrent conversions of the same candidate cannot both create a
-- Campaign — the loser's campaignId write fails here (P2002) and the service
-- reports "already converted" instead of creating a second campaign.
--
-- ON DELETE SET NULL: deleting the Campaign must not delete (or forbid
-- deleting) the sourcing history row; the candidate simply loses the
-- conversion link, exactly like the other nullable audit-fact columns.

ALTER TABLE "ManagedBriefSourcingCandidate" ADD COLUMN "campaignId" TEXT;

ALTER TABLE "ManagedBriefSourcingCandidate"
    ADD CONSTRAINT "ManagedBriefSourcingCandidate_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ManagedBriefSourcingCandidate_campaignId_key"
    ON "ManagedBriefSourcingCandidate"("campaignId");
