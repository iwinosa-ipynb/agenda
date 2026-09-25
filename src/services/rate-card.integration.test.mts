import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

/**
 * Stage 12 integration tests — creator rate cards
 * (src/services/rate-card.service.ts).
 *
 * Strategy mirrors email-verification.integration.test.mts: Prisma replaced
 * with an in-memory stub via node:test module mocking (no DATABASE_URL),
 * "server-only" mocked out. Honours conditional updateMany WHERE clauses so
 * the database-style concurrency semantics are actually exercised.
 *
 * Covers §28: creation, editing (history-preserving), deactivation,
 * reactivation, history/version behavior, authorization/ID scoping.
 */

// ---------------------------------------------------------------------------
// In-memory Prisma stub
// ---------------------------------------------------------------------------

type Row = {
  id: string;
  creatorId: string;
  platform: string;
  serviceType: string;
  price: string; // Decimal arrives/leaves the stub as string
  currency: string;
  description: string | null;
  status: "ACTIVE" | "INACTIVE";
  version: number;
  deactivatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

let rows: Row[] = [];
let nextId = 1;

function resetDb() {
  rows = [];
  nextId = 1;
}

const prismaStub = {
  rateCardItem: {
    findMany: (args: {
      where?: Record<string, unknown>;
      orderBy?: Array<Record<string, string>>;
    }) => {
      const where = (args.where ?? {}) as {
        creatorId?: string;
        id?: string;
        platform?: string;
        serviceType?: string;
        status?: string;
      };

      let matches = rows.filter(
        (row) =>
          (!where.creatorId || row.creatorId === where.creatorId) &&
          (!where.id || row.id === where.id) &&
          (!where.platform || row.platform === where.platform) &&
          (!where.serviceType || row.serviceType === where.serviceType) &&
          (!where.status || row.status === where.status),
      );

      const orderBy = args.orderBy ?? [];
      for (const key of [...orderBy].reverse()) {
        const [[field, dir] = [] as unknown as [string, string]] = Object.entries(key);
        if (field && dir) {
          matches = [...matches].sort((a, b) => {
            const av = String(a[field as keyof Row]);
            const bv = String(b[field as keyof Row]);
            const cmp = av < bv ? -1 : av > bv ? 1 : 0;
            return dir === "desc" ? -cmp : cmp;
          });
        }
      }

      return Promise.resolve(matches.map((row) => structuredClone(row)));
    },
    findFirst: (args: { where: Record<string, unknown> }) => {
      const where = args.where as {
        id?: string;
        creatorId?: string;
        status?: string;
      };
      const row = rows.find(
        (candidate) =>
          (!where.id || candidate.id === where.id) &&
          (!where.creatorId || candidate.creatorId === where.creatorId) &&
          (!where.status || candidate.status === where.status),
      );

      return Promise.resolve(row ? structuredClone(row) : null);
    },
    create: (args: { data: Record<string, unknown> }) => {
      const now = new Date();
      const data = args.data;
      const row: Row = {
        id: `rci-${nextId++}`,
        creatorId: String(data.creatorId),
        platform: String(data.platform),
        serviceType: (data.serviceType as string) ?? "VIDEO",
        price: String(data.price),
        currency: (data.currency as string) ?? "NGN",
        description: (data.description as string | null) ?? null,
        status: (data.status as Row["status"]) ?? "ACTIVE",
        version: (data.version as number) ?? 1,
        deactivatedAt: (data.deactivatedAt as Date | null) ?? null,
        createdAt: now,
        updatedAt: now,
      };

      // Enforce the real (creatorId, platform, serviceType, status) unique
      // constraint so the P2002 path is exercised faithfully.
      const duplicate = rows.some(
        (candidate) =>
          candidate.creatorId === row.creatorId &&
          candidate.platform === row.platform &&
          candidate.serviceType === row.serviceType &&
          candidate.status === row.status,
      );

      if (duplicate) {
        return Promise.reject({ code: "P2002" });
      }

      rows.push(row);

      return Promise.resolve({ id: row.id });
    },
    updateMany: (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      const where = args.where as {
        id?: string;
        creatorId?: string;
        status?: string;
      };

      let count = 0;

      for (const row of rows) {
        const matches =
          (!where.id || row.id === where.id) &&
          (!where.creatorId || row.creatorId === where.creatorId) &&
          (!where.status || row.status === where.status);

        if (matches) {
          Object.assign(row, args.data);
          count += 1;
        }
      }

      return Promise.resolve({ count });
    },
  },
  $transaction: (fn: (tx: unknown) => Promise<unknown>) => {
    // Interactive transaction: the stub is the "database"; run it against the
    // same store (real transactions would isolate, but the service only needs
    // sequential execution semantics for these tests).
    return fn(prismaStub);
  },
};

// ---------------------------------------------------------------------------
// Module mocks — registered BEFORE anything under test is imported
// ---------------------------------------------------------------------------

function mockModule(specifier: string, exports: Record<string, unknown>): void {
  (mock.module as (spec: string, opts: Record<string, unknown>) => void)(
    specifier,
    { exports },
  );
}

mockModule("server-only", {});
mockModule("@/lib/prisma", { prisma: prismaStub });

type RateCardService = typeof import("@/services/rate-card.service");

/** Narrow a result to its success branch (assert.equal can't narrow). */
function expectOk<T>(result: { success: boolean } & { data?: T }): T {
  assert.equal(result.success, true);

  return (result as { success: true; data: T }).data;
}

let service: RateCardService;

describe("Stage 12 — rate cards", () => {
  before(async () => {
    service = await import("@/services/rate-card.service");
  });

  beforeEach(() => {
    resetDb();
  });

  // -------------------------------------------------------------------------
  // Creation
  // -------------------------------------------------------------------------

  describe("createRateCardItem", () => {
    it("creates an ACTIVE v1 item", async () => {
      const result = await service.createRateCardItem("creator-1", {
        platform: "TIKTOK",
        serviceType: "VIDEO",
        price: "150000",
        currency: "NGN",
        description: undefined,
      });

      assert.equal(result.success, true);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.status, "ACTIVE");
      assert.equal(rows[0]?.version, 1);
      assert.equal(rows[0]?.price, "150000.00");
    });

    it("rejects a duplicate ACTIVE listing for the same platform + type", async () => {
      await service.createRateCardItem("creator-1", {
        platform: "TIKTOK",
        serviceType: "VIDEO",
        price: "150000",
        currency: "NGN",
        description: undefined,
      });

      const second = await service.createRateCardItem("creator-1", {
        platform: "TIKTOK",
        serviceType: "VIDEO",
        price: "999",
        currency: "NGN",
        description: undefined,
      });

      assert.equal(second.success, false);
      assert.match(String(second.error), /already have an active rate/i);
      assert.equal(rows.length, 1);
    });

    it("allows the same platform + type after the first is deactivated", async () => {
      const first = await service.createRateCardItem("creator-1", {
        platform: "TIKTOK",
        serviceType: "VIDEO",
        price: "150000",
        currency: "NGN",
        description: undefined,
      });

      await service.toggleRateCardItem(
        "creator-1",
        expectOk(first).itemId,
      );

      const second = await service.createRateCardItem("creator-1", {
        platform: "TIKTOK",
        serviceType: "VIDEO",
        price: "200000",
        currency: "NGN",
        description: undefined,
      });

      assert.equal(second.success, true);
      assert.equal(rows.length, 2);
      assert.equal(rows.filter((r) => r.status === "ACTIVE").length, 1);
    });
  });

  // -------------------------------------------------------------------------
  // History-preserving edit
  // -------------------------------------------------------------------------

  describe("updateRateCardItem", () => {
    it("keeps the old row as INACTIVE history and writes a new ACTIVE v2", async () => {
      const created = await service.createRateCardItem("creator-1", {
        platform: "TIKTOK",
        serviceType: "VIDEO",
        price: "150000",
        currency: "NGN",
        description: undefined,
      });

      const updated = await service.updateRateCardItem("creator-1", {
        itemId: expectOk(created).itemId,
        price: "250000",
        currency: "NGN",
        description: "Updated note",
      });

      assert.equal(updated.success, true);
      assert.equal(rows.length, 2);

      const oldRow = rows.find((r) => r.id === expectOk(created).itemId)!;
      assert.equal(oldRow.status, "INACTIVE");
      assert.equal(oldRow.price, "150000.00");
      assert.ok(oldRow.deactivatedAt instanceof Date);

      const newRow = rows.find((r) => r.id === expectOk(updated).itemId)!;
      assert.equal(newRow.status, "ACTIVE");
      assert.equal(newRow.version, 2);
      assert.equal(newRow.price, "250000.00");
    });

    it("preserves platform + serviceType from the previous row (identity is not editable)", async () => {
      const created = await service.createRateCardItem("creator-1", {
        platform: "X",
        serviceType: "THREAD",
        price: "50000",
        currency: "NGN",
        description: undefined,
      });

      const updated = await service.updateRateCardItem("creator-1", {
        itemId: expectOk(created).itemId,
        price: "75000",
        currency: "NGN",
        description: undefined,
      });

      const newRow = rows.find((r) => r.id === expectOk(updated).itemId)!;

      assert.equal(newRow.platform, "X");
      assert.equal(newRow.serviceType, "THREAD");
      assert.equal(newRow.version, 2);
    });

    it("refuses to edit another creator's item (ownership in the WHERE)", async () => {
      const created = await service.createRateCardItem("creator-1", {
        platform: "TIKTOK",
        serviceType: "VIDEO",
        price: "150000",
        currency: "NGN",
        description: undefined,
      });

      const foreign = await service.updateRateCardItem("creator-2", {
        itemId: expectOk(created).itemId,
        price: "1",
        currency: "NGN",
        description: undefined,
      });

      assert.equal(foreign.success, false);
      // Nothing changed: the original row is still ACTIVE at v1.
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.status, "ACTIVE");
      assert.equal(rows[0]?.version, 1);
      assert.equal(rows[0]?.price, "150000.00");
    });

    it("refuses to edit an already-inactive item (history is frozen)", async () => {
      const created = await service.createRateCardItem("creator-1", {
        platform: "TIKTOK",
        serviceType: "VIDEO",
        price: "150000",
        currency: "NGN",
        description: undefined,
      });

      await service.toggleRateCardItem(
        "creator-1",
        expectOk(created).itemId,
      );

      const edit = await service.updateRateCardItem("creator-1", {
        itemId: expectOk(created).itemId,
        price: "999",
        currency: "NGN",
        description: undefined,
      });

      assert.equal(edit.success, false);
      assert.equal(rows[0]?.price, "150000.00");
    });

    it("serializes concurrent edits: only one wins (conditional deactivation)", async () => {
      const created = await service.createRateCardItem("creator-1", {
        platform: "TIKTOK",
        serviceType: "VIDEO",
        price: "150000",
        currency: "NGN",
        description: undefined,
      });

      const [a, b] = await Promise.all([
        service.updateRateCardItem("creator-1", {
          itemId: expectOk(created).itemId,
          price: "100000",
          currency: "NGN",
          description: undefined,
        }),
        service.updateRateCardItem("creator-1", {
          itemId: expectOk(created).itemId,
          price: "200000",
          currency: "NGN",
          description: undefined,
        }),
      ]);

      const outcomes = [a, b].map((r) => r.success).sort();
      assert.deepEqual(outcomes, [false, true]);

      // Exactly one new ACTIVE row; the old one is history.
      assert.equal(rows.filter((r) => r.status === "ACTIVE").length, 1);
      assert.equal(rows.filter((r) => r.status === "INACTIVE").length, 1);
    });
  });

  // -------------------------------------------------------------------------
  // Deactivation / reactivation
  // -------------------------------------------------------------------------

  describe("toggleRateCardItem", () => {
    it("deactivates an ACTIVE item and stamps deactivatedAt", async () => {
      const created = await service.createRateCardItem("creator-1", {
        platform: "TIKTOK",
        serviceType: "VIDEO",
        price: "150000",
        currency: "NGN",
        description: undefined,
      });

      const result = await service.toggleRateCardItem(
        "creator-1",
        expectOk(created).itemId,
      );

      assert.equal(result.success, true);
      assert.equal(rows[0]?.status, "INACTIVE");
      assert.ok(rows[0]?.deactivatedAt instanceof Date);
    });

    it("reactivates an INACTIVE item with its last values and clears deactivatedAt", async () => {
      const created = await service.createRateCardItem("creator-1", {
        platform: "TIKTOK",
        serviceType: "VIDEO",
        price: "150000",
        currency: "NGN",
        description: undefined,
      });

      await service.toggleRateCardItem("creator-1", expectOk(created).itemId);
      await service.toggleRateCardItem("creator-1", expectOk(created).itemId);

      assert.equal(rows[0]?.status, "ACTIVE");
      assert.equal(rows[0]?.deactivatedAt, null);
      assert.equal(rows[0]?.version, 1);
      assert.equal(rows[0]?.price, "150000.00");
    });

    it("refuses reactivation when an ACTIVE sibling exists", async () => {
      const first = await service.createRateCardItem("creator-1", {
        platform: "TIKTOK",
        serviceType: "VIDEO",
        price: "150000",
        currency: "NGN",
        description: undefined,
      });

      await service.toggleRateCardItem("creator-1", expectOk(first).itemId);

      const second = await service.createRateCardItem("creator-1", {
        platform: "TIKTOK",
        serviceType: "VIDEO",
        price: "200000",
        currency: "NGN",
        description: undefined,
      });

      const reactivate = await service.toggleRateCardItem(
        "creator-1",
        expectOk(first).itemId,
      );

      assert.equal(second.success, true);
      assert.equal(reactivate.success, false);
      assert.match(String(reactivate.error), /already have an active rate/i);
    });

    it("refuses toggling another creator's item", async () => {
      const created = await service.createRateCardItem("creator-1", {
        platform: "TIKTOK",
        serviceType: "VIDEO",
        price: "150000",
        currency: "NGN",
        description: undefined,
      });

      const foreign = await service.toggleRateCardItem(
        "creator-2",
        expectOk(created).itemId,
      );

      assert.equal(foreign.success, false);
      assert.equal(rows[0]?.status, "ACTIVE");
    });

    it("returns not-found for a nonexistent item", async () => {
      const result = await service.toggleRateCardItem(
        "creator-1",
        "00000000-0000-4000-8000-000000000000",
      );

      assert.equal(result.success, false);
      assert.match(String(result.error), /not found/i);
    });
  });

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  describe("reads", () => {
    it("listPublicRateCardItems returns ACTIVE items only", async () => {
      const a = await service.createRateCardItem("creator-1", {
        platform: "TIKTOK",
        serviceType: "VIDEO",
        price: "150000",
        currency: "NGN",
        description: undefined,
      });

      await service.createRateCardItem("creator-1", {
        platform: "X",
        serviceType: "POST",
        price: "50000",
        currency: "NGN",
        description: undefined,
      });

      await service.toggleRateCardItem("creator-1", expectOk(a).itemId);

      const publicItems = await service.listPublicRateCardItems("creator-1");

      assert.equal(publicItems.length, 1);
      assert.equal(publicItems[0]?.platform, "X");
    });

    it("listRateCardItems returns active + history ordered active-first", async () => {
      const a = await service.createRateCardItem("creator-1", {
        platform: "TIKTOK",
        serviceType: "VIDEO",
        price: "150000",
        currency: "NGN",
        description: undefined,
      });

      await service.createRateCardItem("creator-1", {
        platform: "X",
        serviceType: "POST",
        price: "50000",
        currency: "NGN",
        description: undefined,
      });

      await service.toggleRateCardItem("creator-1", expectOk(a).itemId);

      const all = await service.listRateCardItems("creator-1");

      assert.equal(all.length, 2);
      assert.equal(all[0]?.status, "ACTIVE");
      assert.equal(all[1]?.status, "INACTIVE");
    });
  });
});
