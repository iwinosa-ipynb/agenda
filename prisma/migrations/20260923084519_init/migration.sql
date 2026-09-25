-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('CREATOR', 'ADVERTISER');

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('TIKTOK', 'X', 'INSTAGRAM', 'YOUTUBE', 'FACEBOOK');

-- CreateEnum
CREATE TYPE "Category" AS ENUM ('FASHION', 'BEAUTY', 'FITNESS', 'TECH', 'GAMING', 'FOOD', 'TRAVEL', 'LIFESTYLE', 'COMEDY', 'MUSIC', 'SPORTS', 'EDUCATION', 'FINANCE', 'OTHER');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "SocialAccountStatus" AS ENUM ('PENDING_VERIFICATION', 'VERIFIED', 'CONNECTED');

-- CreateEnum
CREATE TYPE "PostStatus" AS ENUM ('SUBMITTED', 'VERIFYING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ObservationIntegrityStatus" AS ENUM ('CLEAN', 'REVIEW', 'REJECTED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "bio" TEXT,
    "location" TEXT,
    "state" TEXT,
    "country" TEXT,
    "category" "Category",
    "followerCount" INTEGER NOT NULL DEFAULT 0,
    "profileImage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialAccount" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "username" TEXT NOT NULL,
    "profileUrl" TEXT NOT NULL,
    "platformUserId" TEXT,
    "followerCount" INTEGER,
    "status" "SocialAccountStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "platformUsername" TEXT,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "grantedScopes" TEXT,
    "connectedAt" TIMESTAMP(3),

    CONSTRAINT "SocialAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdvertiserProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "companyDescription" TEXT,
    "location" TEXT,
    "state" TEXT,
    "country" TEXT,
    "website" TEXT,
    "logoUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdvertiserProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "advertiserId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "category" "Category" NOT NULL,
    "targetLocation" TEXT NOT NULL,
    "targetCountry" TEXT,
    "budget" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "pricePerThousandViews" DECIMAL(14,2) NOT NULL,
    "minimumFollowers" INTEGER NOT NULL DEFAULT 0,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "applicationDeadline" TIMESTAMP(3),
    "contentRequirements" TEXT,
    "rules" TEXT,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignApplication" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignPost" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "postUrl" TEXT NOT NULL,
    "caption" TEXT,
    "creatorNote" TEXT,
    "platformPostId" TEXT,
    "views" INTEGER NOT NULL DEFAULT 0,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "shares" INTEGER NOT NULL DEFAULT 0,
    "verifiedViews" INTEGER NOT NULL DEFAULT 0,
    "status" "PostStatus" NOT NULL DEFAULT 'SUBMITTED',
    "verificationStartedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostVerificationObservation" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "platformPostId" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "views" INTEGER NOT NULL,
    "likes" INTEGER NOT NULL,
    "comments" INTEGER NOT NULL,
    "shares" INTEGER NOT NULL,
    "verifiedViews" INTEGER NOT NULL,
    "verificationResult" "PostStatus" NOT NULL,
    "observationKey" TEXT NOT NULL,
    "integrityStatus" "ObservationIntegrityStatus" NOT NULL,
    "integrityChecks" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PostVerificationObservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "CreatorProfile_userId_key" ON "CreatorProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CreatorProfile_username_key" ON "CreatorProfile"("username");

-- CreateIndex
CREATE INDEX "SocialAccount_creatorId_idx" ON "SocialAccount"("creatorId");

-- CreateIndex
CREATE INDEX "SocialAccount_creatorId_platform_idx" ON "SocialAccount"("creatorId", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "SocialAccount_creatorId_platform_username_key" ON "SocialAccount"("creatorId", "platform", "username");

-- CreateIndex
CREATE UNIQUE INDEX "SocialAccount_platform_platformUserId_key" ON "SocialAccount"("platform", "platformUserId");

-- CreateIndex
CREATE UNIQUE INDEX "AdvertiserProfile_userId_key" ON "AdvertiserProfile"("userId");

-- CreateIndex
CREATE INDEX "Campaign_status_platform_idx" ON "Campaign"("status", "platform");

-- CreateIndex
CREATE INDEX "Campaign_status_category_idx" ON "Campaign"("status", "category");

-- CreateIndex
CREATE INDEX "Campaign_advertiserId_idx" ON "Campaign"("advertiserId");

-- CreateIndex
CREATE INDEX "Campaign_targetLocation_idx" ON "Campaign"("targetLocation");

-- CreateIndex
CREATE INDEX "CampaignApplication_creatorId_idx" ON "CampaignApplication"("creatorId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignApplication_campaignId_creatorId_key" ON "CampaignApplication"("campaignId", "creatorId");

-- CreateIndex
CREATE INDEX "CampaignPost_campaignId_idx" ON "CampaignPost"("campaignId");

-- CreateIndex
CREATE INDEX "CampaignPost_creatorId_idx" ON "CampaignPost"("creatorId");

-- CreateIndex
CREATE INDEX "CampaignPost_status_idx" ON "CampaignPost"("status");

-- CreateIndex
CREATE INDEX "PostVerificationObservation_postId_observedAt_idx" ON "PostVerificationObservation"("postId", "observedAt");

-- CreateIndex
CREATE INDEX "PostVerificationObservation_postId_integrityStatus_idx" ON "PostVerificationObservation"("postId", "integrityStatus");

-- CreateIndex
CREATE INDEX "PostVerificationObservation_platform_idx" ON "PostVerificationObservation"("platform");

-- CreateIndex
CREATE UNIQUE INDEX "PostVerificationObservation_observationKey_key" ON "PostVerificationObservation"("observationKey");

-- AddForeignKey
ALTER TABLE "CreatorProfile" ADD CONSTRAINT "CreatorProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvertiserProfile" ADD CONSTRAINT "AdvertiserProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "AdvertiserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignApplication" ADD CONSTRAINT "CampaignApplication_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignApplication" ADD CONSTRAINT "CampaignApplication_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignPost" ADD CONSTRAINT "CampaignPost_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignPost" ADD CONSTRAINT "CampaignPost_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostVerificationObservation" ADD CONSTRAINT "PostVerificationObservation_postId_fkey" FOREIGN KEY ("postId") REFERENCES "CampaignPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
