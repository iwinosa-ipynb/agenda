-- Stage 12: creator rate cards.
-- Additive only: two new objects, no existing table/column/enum touched.
-- One enum is added (RateCardItemStatus) and one table (RateCardItem).

CREATE TYPE "RateCardItemStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- The creator's own listed starting prices. Editing an ACTIVE item never
-- overwrites it: the old row is deactivated (kept) and a new ACTIVE row is
-- written with version = previous + 1, so listed-rate history stays queryable.
CREATE TABLE "RateCardItem" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "serviceType" TEXT NOT NULL,
    "price" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "description" TEXT,
    "status" "RateCardItemStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "deactivatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateCardItem_pkey" PRIMARY KEY ("id")
);

-- At most one ACTIVE listed rate per (creator, platform, service type).
-- Any number of INACTIVE rows may coexist — that is the history.
CREATE UNIQUE INDEX "RateCardItem_creatorId_platform_serviceType_status_key"
    ON "RateCardItem"("creatorId", "platform", "serviceType", "status");

CREATE INDEX "RateCardItem_creatorId_idx" ON "RateCardItem"("creatorId");
CREATE INDEX "RateCardItem_creatorId_platform_status_idx"
    ON "RateCardItem"("creatorId", "platform", "status");

-- FK added separately so the table build above stays a single statement,
-- mirroring how Prisma emits relations.
ALTER TABLE "RateCardItem"
    ADD CONSTRAINT "RateCardItem_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "CreatorProfile"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
