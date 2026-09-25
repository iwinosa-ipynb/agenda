/*
  Warnings:

  - Added the required column `currency` to the `CampaignApplication` table without a default value. This is not possible if the table is not empty.
  - Added the required column `quoteAmount` to the `CampaignApplication` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "AgreementStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PricingDataAvailability" AS ENUM ('INSUFFICIENT_DATA', 'AVAILABLE');

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "maxCreators" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "CampaignApplication" ADD COLUMN     "currency" TEXT NOT NULL,
ADD COLUMN     "quoteAmount" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "CampaignAgreement" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "advertiserId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "status" "AgreementStatus" NOT NULL DEFAULT 'ACTIVE',
    "platform" "Platform" NOT NULL,
    "agreedAmount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "deliverables" TEXT,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignAgreement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CampaignAgreement_applicationId_key" ON "CampaignAgreement"("applicationId");

-- CreateIndex
CREATE INDEX "CampaignAgreement_advertiserId_idx" ON "CampaignAgreement"("advertiserId");

-- CreateIndex
CREATE INDEX "CampaignAgreement_creatorId_idx" ON "CampaignAgreement"("creatorId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignAgreement_campaignId_creatorId_status_key" ON "CampaignAgreement"("campaignId", "creatorId", "status");

-- CreateIndex
CREATE INDEX "CampaignApplication_status_idx" ON "CampaignApplication"("status");

-- AddForeignKey
ALTER TABLE "CampaignAgreement" ADD CONSTRAINT "CampaignAgreement_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignAgreement" ADD CONSTRAINT "CampaignAgreement_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "CampaignApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignAgreement" ADD CONSTRAINT "CampaignAgreement_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "AdvertiserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignAgreement" ADD CONSTRAINT "CampaignAgreement_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
