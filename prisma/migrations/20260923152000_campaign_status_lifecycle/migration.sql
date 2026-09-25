-- Stage 12: evolve the campaign lifecycle.
-- Renaming preserves any existing rows; no value is dropped.
ALTER TYPE "CampaignStatus" RENAME VALUE 'ACTIVE' TO 'PUBLISHED';
ALTER TYPE "CampaignStatus" RENAME VALUE 'PAUSED' TO 'APPLICATIONS_CLOSED';
ALTER TYPE "CampaignStatus" ADD VALUE 'IN_PROGRESS';
