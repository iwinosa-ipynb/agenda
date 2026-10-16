-- Align the platform fee configuration with the locked payment model.
--
-- DATA-ONLY migration: no schema change. It touches ONLY "PlatformFeeConfig"
-- rows — historical ledger entries, obligations and already-planned milestones
-- (including their frozen creatorCommissionMinor) are deliberately untouched.
-- Fee rates are read once at PLANNING time and frozen onto the milestone, so
-- this update governs milestones planned from now on; nothing is recomputed
-- retroactively.
--
--   * MILESTONE_CREATOR_FEE (NGN) is updated IN PLACE from 1000 bp (10%) —
--     as seeded by 20260924153000_stage13b_milestones — to the current locked
--     rule of 750 bp (7.5%). The existing row keeps its id and history: it is
--     never deleted, re-created, or duplicated (the (currency, feeType,
--     status) unique index permits at most one ACTIVE row per fee type).
--   * AGREEMENT_FUNDING (NGN) at 500 bp (5%) is created because the migration
--     chain never seeded it; without it a single-payment obligation is refused
--     with FEE_NOT_CONFIGURED. Inserted with ON CONFLICT DO NOTHING so an
--     already-configured database is left exactly as-is.
--
-- Deterministic and idempotent: re-running yields the same fee state.

-- 1. Creator commission: in-place update of the single ACTIVE NGN row.
UPDATE "PlatformFeeConfig"
SET "feeBasisPoints" = 750,
    "note" = 'Current locked rule: 7.5% creator marketplace commission per completed milestone.',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "feeType" = 'MILESTONE_CREATOR_FEE'
  AND "currency" = 'NGN'
  AND "status" = 'ACTIVE';

-- Fallback for a database where the ACTIVE creator row is missing entirely:
-- create it at 750 bp. ON CONFLICT guarantees a second ACTIVE row can never
-- appear — if the row above already exists, this statement does nothing.
INSERT INTO "PlatformFeeConfig" ("id", "feeBasisPoints", "currency", "feeType", "status", "note", "effectiveFrom", "createdAt", "updatedAt")
VALUES (
    'fee-creator-750-ngn', 750, 'NGN', 'MILESTONE_CREATOR_FEE', 'ACTIVE',
    'Current locked rule: 7.5% creator marketplace commission per completed milestone.',
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
)
ON CONFLICT ("currency", "feeType", "status") DO NOTHING;

-- 2. Agreement funding: create the missing ACTIVE 5% row (idempotent; never
-- duplicates an already-configured ACTIVE row).
INSERT INTO "PlatformFeeConfig" ("id", "feeBasisPoints", "currency", "feeType", "status", "note", "effectiveFrom", "createdAt", "updatedAt")
VALUES (
    'fee-funding-500-ngn', 500, 'NGN', 'AGREEMENT_FUNDING', 'ACTIVE',
    '5% advertiser agreement-funding fee, charged upfront on the agreement at funding for single-payment agreements.',
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
)
ON CONFLICT ("currency", "feeType", "status") DO NOTHING;
