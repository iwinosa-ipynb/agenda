-- Stage 13C - verification → milestone lifecycle wiring.
-- Additive only: new enum values on MilestoneEventType and one new column on
-- Milestone. No existing column is dropped or retyped; no data reset.

-- The required-post foundation: milestones may require multiple posts. The
-- value freezes at plan time from the explicit milestone terms; existing rows
-- default to 1 (the single-post case).
ALTER TABLE "Milestone" ADD COLUMN "requiredPostCount" INTEGER NOT NULL DEFAULT 1;

ALTER TYPE "MilestoneEventType" ADD VALUE IF NOT EXISTS 'milestone_submission_created';
ALTER TYPE "MilestoneEventType" ADD VALUE IF NOT EXISTS 'milestone_submission_verified';
ALTER TYPE "MilestoneEventType" ADD VALUE IF NOT EXISTS 'milestone_submission_rejected';
ALTER TYPE "MilestoneEventType" ADD VALUE IF NOT EXISTS 'milestone_submission_retryable';
ALTER TYPE "MilestoneEventType" ADD VALUE IF NOT EXISTS 'milestone_review_opened';
ALTER TYPE "MilestoneEventType" ADD VALUE IF NOT EXISTS 'milestone_reverification_started';
ALTER TYPE "MilestoneEventType" ADD VALUE IF NOT EXISTS 'milestone_reverified';
ALTER TYPE "MilestoneEventType" ADD VALUE IF NOT EXISTS 'milestone_verification_failed';
ALTER TYPE "MilestoneEventType" ADD VALUE IF NOT EXISTS 'milestone_review_expired';
ALTER TYPE "MilestoneEventType" ADD VALUE IF NOT EXISTS 'milestone_missing_association';
