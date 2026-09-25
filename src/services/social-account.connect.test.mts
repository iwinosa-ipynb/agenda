import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

/**
 * Stage 11 tests — connect/disconnect service behavior
 * (src/services/social-account.service.ts).
 *
 * Prisma is an in-memory stub via node:test module mocking. The REAL
 * AES-256-GCM token encryption runs (keyed via env) so encrypted-at-rest
 * behavior is verified for real; provider revocation is mocked at the
 * module boundary.
 *
 * Covers: duplicate external identity protection (DB-constraint race and
 * pre-check), valid separate connections, reconnect (idempotent update),
 * disconnect (credential wipe + best-effort revocation), and the
 * never-return-tokens-to-clients boundary.
 */

// ---------------------------------------------------------------------------
// In-memory Prisma stub (uniqueness semantics included)
// ---------------------------------------------------------------------------

type SocialAccountRow = {
  id: string;
  creatorId: string;
  platform: string;
  username: string;
  profileUrl: string;
  platformUserId: string | null;
  platformUsername: string | null;
  status: string;
  connectedAt: Date | null;
  grantedScopes: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  createdAt: Date;
};

let accounts: SocialAccountRow[] = [];
let creates: Array<Record<string, unknown>> = [];
let updates: Array<Record<string, unknown>> = [];
let updateManyCalls: Array<Record<string, unknown>> = [];
let nextId = 1;

let failCreateWithP2002 = false;

function uniqueViolation(
  where: { platform: string; platformUserId: string | null },
): boolean {
  if (!where.platformUserId) {
    return false;
  }

  return accounts.some(
    (row) =>
      row.platform === where.platform &&
      row.platformUserId === where.platformUserId,
  );
}

const prismaStub = {
  socialAccount: {
    findUnique: (args: {
      where: { platform_platformUserId: { platform: string; platformUserId: string } };
    }) => {
      const row = accounts.find(
        (candidate) =>
          candidate.platform === args.where.platform_platformUserId.platform &&
          candidate.platformUserId === args.where.platform_platformUserId.platformUserId,
      );

      return Promise.resolve(row ? structuredClone(row) : null);
    },
    findFirst: (args: {
      where: {
        creatorId: string;
        platform: string;
        connectedAt?: { not: null } | null;
      };
    }) => {
      const row = accounts
        .filter(
          (candidate) =>
            candidate.creatorId === args.where.creatorId &&
            candidate.platform === args.where.platform &&
            (!args.where.connectedAt || candidate.connectedAt !== null),
        )
        .sort(
          (a, b) => (b.connectedAt?.getTime() ?? 0) - (a.connectedAt?.getTime() ?? 0),
        )[0];

      return Promise.resolve(row ? structuredClone(row) : null);
    },
    findMany: (args: {
      where: { creatorId: string; platform: { in: string[] } };
    }) => {
      const rows = accounts.filter(
        (candidate) =>
          candidate.creatorId === args.where.creatorId &&
          args.where.platform.in.includes(candidate.platform),
      );

      return Promise.resolve(structuredClone(rows));
    },
    create: (args: { data: Record<string, unknown> }) => {
      creates.push(structuredClone(args.data));

      if (failCreateWithP2002 || uniqueViolation(args.data as never)) {
        return Promise.reject({ code: "P2002" });
      }

      const row = {
        id: `sa-${nextId++}`,
        createdAt: new Date(),
        status: "PENDING_VERIFICATION",
        platformUserId: null,
        platformUsername: null,
        connectedAt: null,
        grantedScopes: null,
        accessToken: null,
        refreshToken: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        ...args.data,
      } as SocialAccountRow;

      accounts.push(row);

      return Promise.resolve({ id: row.id });
    },
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => {
      updates.push(structuredClone(args));

      const row = accounts.find((candidate) => candidate.id === args.where.id);

      if (!row) {
        return Promise.reject({ code: "P2025" });
      }

      Object.assign(row, args.data);

      return Promise.resolve({ id: row.id });
    },
    updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      updateManyCalls.push(structuredClone(args));

      let count = 0;

      for (const row of accounts) {
        const where = args.where as {
          id?: string;
          creatorId?: string;
          platform?: string;
          connectedAt?: { not: null } | null;
        };

        const matches =
          (!where.id || row.id === where.id) &&
          (!where.creatorId || row.creatorId === where.creatorId) &&
          (!where.platform || row.platform === where.platform) &&
          (!where.connectedAt || row.connectedAt !== null);

        if (matches) {
          Object.assign(row, args.data);
          count += 1;
        }
      }

      return Promise.resolve({ count });
    },
  },
};

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

function mockModule(specifier: string, exports: Record<string, unknown>): void {
  (mock.module as (spec: string, opts: Record<string, unknown>) => void)(
    specifier,
    { exports },
  );
}

mockModule("server-only", {});
mockModule("@/lib/prisma", { prisma: prismaStub });

// Provider revocation is mocked; real revocation is an external API call.
let revocationCalls: Array<{ platform: string; token: string }> = [];
let revocationSucceeds = true;

mockModule("@/services/token-lifecycle.service", {
  revokeProviderToken: (platform: string, token: string) => {
    revocationCalls.push({ platform, token });

    return Promise.resolve(revocationSucceeds);
  },
});

type Service = typeof import("@/services/social-account.service");

let service: Service;

const X_IDENTITY = {
  platformUserId: "x-user-111",
  platformUsername: "creator_x",
  displayName: "Creator X",
};

const TIKTOK_IDENTITY = {
  platformUserId: "tiktok-open-id-222",
  platformUsername: "creatortt",
  displayName: "Creator TT",
};

const TOKENS = {
  accessToken: "plain-access-token",
  refreshToken: "plain-refresh-token",
  accessTokenExpiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
  refreshTokenExpiresAt: null,
  grantedScopes: "users.read tweet.read offline.access",
};

describe("Stage 11 — connect/disconnect service", () => {
  before(async () => {
    service = await import("@/services/social-account.service");
  });

  beforeEach(() => {
    accounts = [];
    creates = [];
    updates = [];
    updateManyCalls = [];
    revocationCalls = [];
    revocationSucceeds = true;
    failCreateWithP2002 = false;
    nextId = 1;
    process.env.SOCIAL_TOKEN_ENCRYPTION_KEY = "stage11-connect-test-key";
  });

  describe("connectPlatformAccount — duplicate protection", () => {
    it("connects a new X account with encrypted tokens", async () => {
      const result = await service.connectPlatformAccount(
        "creator-1",
        "X",
        X_IDENTITY,
        TOKENS,
      );

      assert.equal(result.success, true);
      assert.equal(creates.length, 1);
      assert.equal(creates[0]?.platform, "X");
      assert.equal(creates[0]?.platformUserId, "x-user-111");
      assert.equal(creates[0]?.status, "CONNECTED");

      // Stored values are ciphertext, never plaintext.
      const storedAccess = String(creates[0]?.accessToken);

      assert.notEqual(storedAccess, TOKENS.accessToken);
      assert.ok(!String(JSON.stringify(creates[0])).includes(TOKENS.accessToken));

      // And it decrypts back with the same key (real AES-256-GCM ran).
      const { decryptToken } = await import("@/lib/token-encryption");

      assert.equal(decryptToken(storedAccess), TOKENS.accessToken);
    });

    it("refuses the same external X identity for a second Agenda user (pre-check)", async () => {
      await service.connectPlatformAccount("creator-1", "X", X_IDENTITY, TOKENS);

      const second = await service.connectPlatformAccount(
        "creator-2",
        "X",
        X_IDENTITY,
        TOKENS,
      );

      assert.equal(second.success, false);
      assert.match(String(second.error), /already connected to another creator/);
      assert.equal(creates.length, 1);
    });

    it("refuses the same external TikTok identity for a second Agenda user", async () => {
      await service.connectPlatformAccount("creator-1", "TIKTOK", TIKTOK_IDENTITY, TOKENS);

      const second = await service.connectPlatformAccount(
        "creator-2",
        "TIKTOK",
        TIKTOK_IDENTITY,
        TOKENS,
      );

      assert.equal(second.success, false);
      assert.match(String(second.error), /already connected to another creator/);
    });

    it("rejects a duplicate-identity race at the DB constraint (P2002)", async () => {
      failCreateWithP2002 = true;

      const result = await service.connectPlatformAccount(
        "creator-1",
        "X",
        X_IDENTITY,
        TOKENS,
      );

      assert.equal(result.success, false);
      assert.match(String(result.error), /already connected to another creator/);
    });

    it("allows the SAME creator to hold separate X and TikTok connections", async () => {
      const x = await service.connectPlatformAccount("creator-1", "X", X_IDENTITY, TOKENS);
      const tt = await service.connectPlatformAccount(
        "creator-1",
        "TIKTOK",
        TIKTOK_IDENTITY,
        TOKENS,
      );

      assert.equal(x.success, true);
      assert.equal(tt.success, true);
      assert.equal(creates.length, 2);
    });

    it("rejects a connection without a platform-verified identity", async () => {
      const result = await service.connectPlatformAccount("creator-1", "X", {
        platformUserId: "",
        platformUsername: "someone",
        displayName: null,
      }, TOKENS);

      assert.equal(result.success, false);
      assert.match(String(result.error), /did not confirm/);
    });

    it("fails closed when the encryption key is missing (no plaintext persisted)", async () => {
      delete process.env.SOCIAL_TOKEN_ENCRYPTION_KEY;

      const result = await service.connectPlatformAccount(
        "creator-1",
        "X",
        X_IDENTITY,
        TOKENS,
      );

      assert.equal(result.success, false);
      assert.match(String(result.error), /encryption is not configured/);
      assert.equal(creates.length, 0);
    });
  });

  describe("reconnect", () => {
    it("updates credentials in place when the same creator reconnects", async () => {
      await service.connectPlatformAccount("creator-1", "X", X_IDENTITY, TOKENS);

      const refreshedTokens = {
        ...TOKENS,
        accessToken: "new-plain-access",
        refreshToken: "new-plain-refresh",
        grantedScopes: "users.read tweet.read offline.access",
      };

      const result = await service.connectPlatformAccount(
        "creator-1",
        "X",
        { ...X_IDENTITY, platformUsername: "creator_x_new" },
        refreshedTokens,
      );

      assert.equal(result.success, true);
      assert.equal(result.data?.reconnected, true);
      assert.equal(creates.length, 1);
      assert.equal(updates.length, 1);

      const data = updates[0]?.data as Record<string, unknown>;

      assert.notEqual(data.accessToken, "new-plain-access");
      assert.equal(data.status, "CONNECTED");
      assert.equal(data.platformUsername, "creator_x_new");
    });
  });

  describe("disconnect", () => {
    it("clears every credential field and attempts provider revocation", async () => {
      const row = (await service.connectPlatformAccount(
        "creator-1",
        "X",
        X_IDENTITY,
        TOKENS,
      )) as { success: true; data: { accountId: string } };

      const result = await service.disconnectPlatformAccount("creator-1", "X");

      assert.equal(result.success, true);
      assert.equal(revocationCalls.length, 1);
      assert.equal(revocationCalls[0]?.platform, "X");
      // The token passed to revocation is the DECRYPTED access token.
      assert.equal(revocationCalls[0]?.token, TOKENS.accessToken);

      const after = accounts.find(
        (candidate) => candidate.id === row.data.accountId,
      ) as SocialAccountRow;

      assert.equal(after.accessToken, null);
      assert.equal(after.refreshToken, null);
      assert.equal(after.platformUserId, null);
      assert.equal(after.connectedAt, null);
      assert.equal(after.status, "PENDING_VERIFICATION");
    });

    it("still disconnects locally when provider revocation fails (documented limitation)", async () => {
      await service.connectPlatformAccount("creator-1", "X", X_IDENTITY, TOKENS);
      revocationSucceeds = false;

      const result = await service.disconnectPlatformAccount("creator-1", "X");

      assert.equal(result.success, true);

      const after = accounts.find(
        (candidate) => candidate.creatorId === "creator-1",
      ) as SocialAccountRow;

      assert.equal(after.accessToken, null);
      assert.equal(after.refreshToken, null);
    });

    it("refuses to disconnect another creator's connection", async () => {
      await service.connectPlatformAccount("creator-1", "X", X_IDENTITY, TOKENS);

      const result = await service.disconnectPlatformAccount("creator-2", "X");

      assert.equal(result.success, false);
    });

    it("is a safe no-op when nothing is connected", async () => {
      const result = await service.disconnectPlatformAccount("creator-1", "X");

      assert.equal(result.success, false);
      assert.match(String(result.error), /No connected account/);
    });
  });

  describe("client-facing summaries never carry token material", () => {
    it("ConnectedAccountSummary contains no credential fields", async () => {
      await service.connectPlatformAccount("creator-1", "TIKTOK", TIKTOK_IDENTITY, TOKENS);

      const summaries = await service.listCreatorConnectedAccounts("creator-1");

      assert.equal(summaries.length, 1);

      const json = JSON.stringify(summaries);

      assert.ok(!json.includes(TOKENS.accessToken));
      assert.ok(!json.includes(TOKENS.refreshToken));
      // Health flags are presence-only booleans.
      assert.equal(summaries[0]?.refreshable, true);
      assert.equal(summaries[0]?.tokenExpired, false);
    });
  });
});
