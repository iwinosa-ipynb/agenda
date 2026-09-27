-- Agenda Managed (V1, slice 2) — support review of managed briefs.
-- Additive only: four nullable fact columns on ManagedBrief. No existing
-- column, enum or table is modified and nothing is dropped.
--
-- These columns are the audit trail for the ONLY two status transitions the
-- support-review path owns (SUBMITTED → IN_REVIEW, IN_REVIEW → CLOSED),
-- following the platform's established fact-column convention
-- (Campaign.publishedAt, Milestone.advertiserConfirmedAt/By). They are
-- written exclusively by the server-authorized transition path behind the
-- Stage 14D seam (role + support roster, re-read fresh from the database);
-- no client input can ever set them.

ALTER TABLE "ManagedBrief" ADD COLUMN "reviewStartedAt" TIMESTAMP(3);
ALTER TABLE "ManagedBrief" ADD COLUMN "reviewStartedById" TEXT;
ALTER TABLE "ManagedBrief" ADD COLUMN "closedAt" TIMESTAMP(3);
ALTER TABLE "ManagedBrief" ADD COLUMN "closedById" TEXT;
