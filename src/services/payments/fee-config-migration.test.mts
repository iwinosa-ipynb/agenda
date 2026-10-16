/**
 * Fee-configuration migration tests — `20261006120000_fee_config_locked_payment_rates`.
 *
 * The migration is DATA-ONLY: it must leave the database in exactly this state
 * and touch nothing else.
 *
 *   a. exactly one ACTIVE NGN MILESTONE_CREATOR_FEE at 750 bp;
 *   b. exactly one ACTIVE NGN AGREEMENT_FUNDING at 500 bp;
 *   c. no duplicate ACTIVE fee row can be created (unique index + ON CONFLICT);
 *   d. the existing creator fee row is updated IN PLACE (id/history preserved);
 *   e. historical milestone/ledger/obligation amounts are untouched.
 *
 * The SQL is executed against an in-memory SQLite database seeded with the
 * pre-migration production state (rows exactly as
 * `20260924153000_stage13b_milestones` seeded them), plus representative
 * financial history that must survive byte-for-byte. No real database is
 * contacted.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const MIGRATION_URL = new URL(
  "../../../prisma/migrations/20261006120000_fee_config_locked_payment_rates/migration.sql",
  import.meta.url,
);

const migrationSql = readFileSync(fileURLToPath(MIGRATION_URL), "utf8");

type FeeRow = {
  id: string;
  feeBasisPoints: number;
  currency: string;
  feeType: string;
  status: string;
  note: string | null;
  createdAt: string;
};

/** Pre-migration production state + financial history that must not change. */
function seedDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");

  db.exec(`
    CREATE TABLE "PlatformFeeConfig" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "feeBasisPoints" INTEGER NOT NULL,
      "currency" TEXT NOT NULL,
      "feeType" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'ACTIVE',
      "note" TEXT,
      "effectiveFrom" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP NOT NULL
    );
    CREATE UNIQUE INDEX "PlatformFeeConfig_currency_feeType_status_key"
      ON "PlatformFeeConfig"("currency", "feeType", "status");

    CREATE TABLE "Milestone" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "creatorAmountMinor" TEXT NOT NULL,
      "creatorCommissionMinor" TEXT NOT NULL
    );
    CREATE TABLE "LedgerEntry" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "account" TEXT NOT NULL,
      "amountMinor" TEXT NOT NULL
    );
    CREATE TABLE "FinancialObligation" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "platformFeeMinor" TEXT NOT NULL,
      "advertiserTotalMinor" TEXT NOT NULL
    );
  `);

  // Exactly the rows 20260924153000_stage13b_milestones seeded.
  db.exec(`
    INSERT INTO "PlatformFeeConfig"
      ("id", "feeBasisPoints", "currency", "feeType", "status", "note", "effectiveFrom", "createdAt", "updatedAt")
    VALUES
      ('seed-fee-adv-500-ngn', 500, 'NGN', 'MILESTONE_ADVERTISER_FEE', 'ACTIVE',
       'Stage 13B locked rules: 5% advertiser service fee per completed milestone.',
       '2026-09-24 10:59:15', '2026-09-24 10:59:15', '2026-09-24 10:59:15'),
      ('seed-fee-creator-1000-ngn', 1000, 'NGN', 'MILESTONE_CREATOR_FEE', 'ACTIVE',
       'Stage 13B locked rules: 10% creator marketplace commission per completed milestone.',
       '2026-09-24 10:59:15', '2026-09-24 10:59:15', '2026-09-24 10:59:15');
  `);

  // Hypothetical financial history: a milestone frozen under the OLD rate and
  // its settled ledger lines. The migration must never rewrite these.
  db.exec(`
    INSERT INTO "Milestone" VALUES
      ('m-frozen-10pct', '30000000', '3000000');
    INSERT INTO "LedgerEntry" VALUES
      ('le-1', 'platform:creator-commission', '3000000'),
      ('le-2', 'platform:escrow', '30000000');
    INSERT INTO "FinancialObligation" VALUES
      ('ob-1', '0', '30000000');
  `);

  return db;
}

function activeRows(db: DatabaseSync, feeType: string): FeeRow[] {
  return db
    .prepare(
      `SELECT * FROM "PlatformFeeConfig"
       WHERE "currency" = 'NGN' AND "feeType" = ? AND "status" = 'ACTIVE'`,
    )
    .all(feeType) as unknown as FeeRow[];
}

function snapshotHistory(db: DatabaseSync): unknown {
  return {
    milestones: db.prepare(`SELECT * FROM "Milestone"`).all(),
    ledger: db.prepare(`SELECT * FROM "LedgerEntry"`).all(),
    obligations: db.prepare(`SELECT * FROM "FinancialObligation"`).all(),
  };
}

describe("fee-config migration 20261006120000_fee_config_locked_payment_rates", () => {
  it("a. leaves exactly ONE ACTIVE NGN MILESTONE_CREATOR_FEE at 750 bp with the 7.5% note", () => {
    const db = seedDatabase();
    db.exec(migrationSql);

    const rows = activeRows(db, "MILESTONE_CREATOR_FEE");

    assert.equal(rows.length, 1);
    assert.equal(rows[0].feeBasisPoints, 750);
    assert.match(rows[0].note ?? "", /7\.5% creator marketplace commission/);
    db.close();
  });

  it("b. leaves exactly ONE ACTIVE NGN AGREEMENT_FUNDING at 500 bp with a 5% funding note", () => {
    const db = seedDatabase();
    db.exec(migrationSql);

    const rows = activeRows(db, "AGREEMENT_FUNDING");

    assert.equal(rows.length, 1);
    assert.equal(rows[0].feeBasisPoints, 500);
    assert.match(rows[0].note ?? "", /5%.*agreement-funding fee/i);
    db.close();
  });

  it("c. refuses any duplicate ACTIVE fee row (unique index) and is idempotent on re-run", () => {
    const db = seedDatabase();
    db.exec(migrationSql);

    // A second ACTIVE creator row must be rejected by the unique constraint…
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO "PlatformFeeConfig"
             ("id", "feeBasisPoints", "currency", "feeType", "status", "effectiveFrom", "createdAt", "updatedAt")
             VALUES ('dup-creator', 1000, 'NGN', 'MILESTONE_CREATOR_FEE', 'ACTIVE',
                     CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          )
          .run(),
      /UNIQUE/i,
    );

    // …as must a second ACTIVE funding row.
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO "PlatformFeeConfig"
             ("id", "feeBasisPoints", "currency", "feeType", "status", "effectiveFrom", "createdAt", "updatedAt")
             VALUES ('dup-funding', 1500, 'NGN', 'AGREEMENT_FUNDING', 'ACTIVE',
                     CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          )
          .run(),
      /UNIQUE/i,
    );

    assert.equal(activeRows(db, "MILESTONE_CREATOR_FEE").length, 1);
    assert.equal(activeRows(db, "AGREEMENT_FUNDING").length, 1);

    // Re-running the migration changes nothing (ON CONFLICT DO NOTHING + the
    // same in-place UPDATE target).
    db.exec(migrationSql);
    assert.equal(activeRows(db, "MILESTONE_CREATOR_FEE").length, 1);
    assert.equal(activeRows(db, "AGREEMENT_FUNDING").length, 1);
    assert.equal(activeRows(db, "MILESTONE_CREATOR_FEE")[0].feeBasisPoints, 750);
    db.close();
  });

  it("d. updates the existing creator fee row IN PLACE (id and createdAt preserved)", () => {
    const db = seedDatabase();
    const before = activeRows(db, "MILESTONE_CREATOR_FEE")[0];
    db.exec(migrationSql);
    const after = activeRows(db, "MILESTONE_CREATOR_FEE")[0];

    // Same row, same history — only the rate/note changed.
    assert.equal(after.id, "seed-fee-creator-1000-ngn");
    assert.equal(after.id, before.id);
    assert.equal(after.createdAt, before.createdAt);
    assert.equal(before.feeBasisPoints, 1000);
    assert.equal(after.feeBasisPoints, 750);

    // Static guards: an UPDATE, never a delete/re-create of the row.
    assert.match(migrationSql, /UPDATE "PlatformFeeConfig"[\s\S]*"feeBasisPoints" = 750/);
    assert.doesNotMatch(migrationSql, /DELETE\s+FROM\s+"PlatformFeeConfig"/i);
    assert.doesNotMatch(
      migrationSql,
      /INSERT\s+ON\s+CONFLICT[\s\S]*seed-fee-creator-1000-ngn/i,
    );
    db.close();
  });

  it("e. leaves historical milestone, ledger and obligation amounts untouched", () => {
    const db = seedDatabase();
    const before = snapshotHistory(db);
    db.exec(migrationSql);
    const after = snapshotHistory(db);

    assert.deepEqual(after, before);

    // Static guard: the migration contains no DML against financial history.
    assert.doesNotMatch(
      migrationSql,
      /\b(INSERT INTO|UPDATE|DELETE FROM)\s+"?(Milestone|LedgerEntry|FinancialObligation|CreatorPayout|FinancialEvent|CampaignAgreement)"?/i,
    );
    db.close();
  });

  it("does not alter the 5% advertiser milestone fee seeded by Stage 13B", () => {
    const db = seedDatabase();
    db.exec(migrationSql);

    const advertiser = activeRows(db, "MILESTONE_ADVERTISER_FEE");
    assert.equal(advertiser.length, 1);
    assert.equal(advertiser[0].feeBasisPoints, 500);
    assert.equal(advertiser[0].id, "seed-fee-adv-500-ngn");
    db.close();
  });
});
