-- Stage 13B corrections (audit fix): explicit milestone schedule fields,
-- immutable MilestoneSubmission history, support authorization roster.
-- Additive only. No existing column is dropped or retyped; no data reset.

-- Per-milestone explicit schedule (explicit milestone terms; amounts were
-- already per-milestone columns — this adds the date dimensions).
ALTER TABLE "Milestone" ADD COLUMN "startDate" TIMESTAMP(3);
ALTER TABLE "Milestone" ADD COLUMN "dueDate" TIMESTAMP(3);

-- Immutable per-submission history: every submission (original + each
-- correction) is appended here and never updated or deleted.
CREATE TABLE "MilestoneSubmission" (
    "id" TEXT NOT NULL,
    "milestoneId" TEXT NOT NULL,
    "agreementId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "postId" TEXT NOT NULL,
    "submittedById" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verificationStatus" "PostStatus" NOT NULL DEFAULT 'SUBMITTED',
    "verifiedAt" TIMESTAMP(3),
    "causedByCorrectionRequestNote" TEXT,
    "causedByCorrectionRequestedBy" TEXT,
    "causedByCorrectionRequestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MilestoneSubmission_pkey" PRIMARY KEY ("id")
);

-- Support authorization roster (trusted seam): only listed user ids may act
-- as SUPPORT. Fail-closed — an empty roster authorizes nobody. No client
-- path reads or writes it.
ALTER TABLE "User" ADD COLUMN "supportRosterMember" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "MilestoneSubmission"
    ADD CONSTRAINT "MilestoneSubmission_milestoneId_fkey"
    FOREIGN KEY ("milestoneId") REFERENCES "Milestone"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MilestoneSubmission"
    ADD CONSTRAINT "MilestoneSubmission_postId_fkey"
    FOREIGN KEY ("postId") REFERENCES "CampaignPost"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- One submission per sequence per milestone; one history row per post.
CREATE UNIQUE INDEX "MilestoneSubmission_milestoneId_sequence_key" ON "MilestoneSubmission"("milestoneId", "sequence");
CREATE UNIQUE INDEX "MilestoneSubmission_postId_key" ON "MilestoneSubmission"("postId");
CREATE INDEX "MilestoneSubmission_milestoneId_submittedAt_idx" ON "MilestoneSubmission"("milestoneId", "submittedAt");
CREATE INDEX "MilestoneSubmission_agreementId_idx" ON "MilestoneSubmission"("agreementId");
