import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

/**
 * Stage 11 tests — social token lifecycle
 * (src/services/token-lifecycle.service.ts).
 *
 * Strategy mirrors the other .mts suites: Prisma is an in-memory stub via
 * node:test module mocking; the provider refresh/revoke functions are
 * mocked at module boundary. Covers the brief §9 taxonomy:
 * valid / expired-refreshable / revoked / temporary-provider-failure,
 * plus rotation-safe storage and fail-closed encryption.
 */

// ---------------------------------------------------------------------------
// In-memory Prisma stub
// ---------------------------------------------------------------------------

type SocialAccountRow = {
  id: string;
  creatorId: string;
  platform: string;
  connectedAt: Date | null;
  accessToken: string | null;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  grantedScopes: string | null;
  status: string;
};

let accounts: SocialAccountRow[] = [];
let updates: Array<Record<string, unknown>> = [];
let nextId = 1;

const prismaStub = {
  socialAccount: {
    findFirst: (args: {
      where: {
        creatorId: string;
        platform: string;
        connectedAt: { not: null } | null;
      };
    }) => {
      const row = accounts.find(
        (candidate) =>
          candidate.creatorId === args.where.creatorId &&
          candidate.platform === args.where.platform &&
          candidate.connectedAt !== null,
      );

      return Promise.resolve(row ? structuredClone(row) : null);
    },
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => {
      updates.push(structuredClone(args));

      const row = accounts.find((candidate) => candidate.id === args.where.id);

      if (!row) {
        return Promise.reject({ code: "P2025" });
      }

      Object.assign(row, args.data);

      return Promise.resolve({ ...row });
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

// Real token encryption, keyed from the environment per test.
const ENCRYPTION_KEY_ENV_VAR = "SOCIAL_TOKEN_ENCRYPTION_KEY";

mockModule("@/lib/token-encryption", {
  ENCRYPTION_KEY_ENV_VAR,
  encryptToken: (plaintext: string): string | null => {
    const raw = process.env[ENCRYPTION_KEY_ENV_VAR];

    if (!raw || raw.trim().length === 0) {
      return null;
    }

    return Buffer.from(`enc:${plaintext}`).toString("base64");
  },
  decryptToken: (stored: string | null | undefined): string | null => {
    if (!stored) {
      return null;
    }

    try {
      const decoded = Buffer.from(stored, "base64").toString("utf8");

      return decoded.startsWith("enc:") ? decoded.slice(4) : null;
    } catch {
      return null;
    }
  },
});

// Provider refresh/revoke behavior is configurable per test.
type RefreshBehavior = "ok" | "auth_rejected" | "provider_down";
let refreshBehavior: RefreshBehavior = "ok";
let refreshCalls = 0;

class FakeVerificationFailureError extends Error {
  constructor(public readonly kind: string) {
    super(`verification failure: ${kind}`);
    this.name = "VerificationFailureError";
  }
}

function refreshedBundle() {
  return {
    accessToken: "new-access-token",
    refreshToken: "new-refresh-token",
    accessTokenExpiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
    refreshTokenExpiresAt: new Date(Date.now() + 300 * 24 * 60 * 60 * 1000),
    grantedScopes: "user.info.basic,video.list",
  };
}

mockModule("@/services/social-connections/tiktok-oauth", {
  refreshTikTokAccessToken: () => {
    refreshCalls += 1;

    if (refreshBehavior === "auth_rejected") {
      return Promise.reject(new FakeVerificationFailureError("PROVIDER_AUTH"));
    }

    if (refreshBehavior === "provider_down") {
      return Promise.reject(
        new FakeVerificationFailureError("PROVIDER_UNAVAILABLE"),
      );
    }

    return Promise.resolve(refreshedBundle());
  },
  revokeTikTokToken: () => Promise.resolve(true),
});

mockModule("@/services/social-connections/x-oauth", {
  refreshXAccessToken: () => {
    refreshCalls += 1;

    if (refreshBehavior === "auth_rejected") {
      return Promise.reject(new FakeVerificationFailureError("PROVIDER_AUTH"));
    }

    if (refreshBehavior === "provider_down") {
      return Promise.reject(
        new FakeVerificationFailureError("PROVIDER_UNAVAILABLE"),
      );
    }

    return Promise.resolve(refreshedBundle());
  },
  revokeXToken: () => Promise.resolve(true),
});

type Lifecycle = typeof import("@/services/token-lifecycle.service");

let lifecycle: Lifecycle;

function addConnectedAccount(overrides: Partial<SocialAccountRow> = {}): SocialAccountRow {
  const row: SocialAccountRow = {
    id: `sa-${nextId++}`,
    creatorId: "creator-1",
    platform: "TIKTOK",
    connectedAt: new Date(),
    accessToken: Buffer.from("enc:old-access-token").toString("base64"),
    refreshToken: Buffer.from("enc:old-refresh-token").toString("base64"),
    accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    refreshTokenExpiresAt: null,
    grantedScopes: "user.info.basic,video.list",
    status: "CONNECTED",
    ...overrides,
  };

  accounts.push(row);

  return row;
}

describe("Stage 11 — social token lifecycle", () => {
  before(async () => {
    lifecycle = await import("@/services/token-lifecycle.service");
  });

  beforeEach(() => {
    accounts = [];
    updates = [];
    refreshCalls = 0;
    refreshBehavior = "ok";
    process.env[ENCRYPTION_KEY_ENV_VAR] = "stage11-test-key";
  });

  describe("getConnectionHealth", () => {
    it("reports VALID for an unexpired token", async () => {
      addConnectedAccount();

      assert.equal(
        await lifecycle.getConnectionHealth("creator-1", "TIKTOK"),
        "VALID",
      );
    });

    it("reports EXPIRED when the access token expired but refresh exists", async () => {
      addConnectedAccount({
        accessTokenExpiresAt: new Date(Date.now() - 1000),
      });

      assert.equal(
        await lifecycle.getConnectionHealth("creator-1", "TIKTOK"),
        "EXPIRED",
      );
    });

    it("reports REVOKED when no connected account exists", async () => {
      assert.equal(
        await lifecycle.getConnectionHealth("creator-1", "TIKTOK"),
        "REVOKED",
      );
    });

    it("reports REVOKED when expired with no refresh token", async () => {
      addConnectedAccount({
        accessTokenExpiresAt: new Date(Date.now() - 1000),
        refreshToken: null,
      });

      assert.equal(
        await lifecycle.getConnectionHealth("creator-1", "TIKTOK"),
        "REVOKED",
      );
    });
  });

  describe("getUsableAccessToken", () => {
    it("returns the stored token when still valid (no refresh call)", async () => {
      addConnectedAccount();

      const token = await lifecycle.getUsableAccessToken("creator-1", "TIKTOK");

      assert.equal(token, "old-access-token");
      assert.equal(refreshCalls, 0);
    });

    it("transparently refreshes an expired token and persists rotated credentials encrypted", async () => {
      addConnectedAccount({
        accessTokenExpiresAt: new Date(Date.now() - 1000),
      });

      const token = await lifecycle.getUsableAccessToken("creator-1", "TIKTOK");

      assert.equal(token, "new-access-token");
      assert.equal(refreshCalls, 1);

      // The update stored the ROTATED refresh token, encrypted.
      assert.equal(updates.length, 1);
      const data = updates[0]?.data as Record<string, string | null>;

      // Both values are ciphertext (mock: base64 of "enc:<plaintext>").
      assert.equal(
        Buffer.from(String(data.accessToken), "base64").toString("utf8"),
        "enc:new-access-token",
      );
      assert.equal(
        Buffer.from(String(data.refreshToken), "base64").toString("utf8"),
        "enc:new-refresh-token",
      );
      assert.equal(data.status, "CONNECTED");
    });

    it("returns the raw token when expired but not refreshable (graceful)", async () => {
      addConnectedAccount({
        accessTokenExpiresAt: new Date(Date.now() - 1000),
        refreshToken: null,
      });

      const token = await lifecycle.getUsableAccessToken("creator-1", "TIKTOK");

      assert.equal(token, "old-access-token");
    });
  });

  describe("refreshStoredTokens — failure taxonomy", () => {
    it("clears credentials only on definitive provider rejection (REVOKED)", async () => {
      const row = addConnectedAccount({
        accessTokenExpiresAt: new Date(Date.now() - 1000),
      });
      refreshBehavior = "auth_rejected";

      const result = await lifecycle.refreshStoredTokens(
        row.id,
        "old-refresh-token",
        "TIKTOK",
      );

      assert.equal(result, null);
      assert.equal(updates.length, 1);

      const data = updates[0]?.data as Record<string, unknown>;

      // Credentials cleared, connection downgraded — but NOT deleted, and
      // the platform identity is preserved for audit.
      assert.equal(data.accessToken, null);
      assert.equal(data.refreshToken, null);
      assert.equal(data.status, "PENDING_VERIFICATION");
    });

    it("writes NOTHING on a temporary provider failure", async () => {
      const row = addConnectedAccount({
        accessTokenExpiresAt: new Date(Date.now() - 1000),
      });
      refreshBehavior = "provider_down";

      const result = await lifecycle.refreshStoredTokens(
        row.id,
        "old-refresh-token",
        "TIKTOK",
      );

      assert.equal(result, null);
      // No update at all: a temporary failure must not mutate state.
      assert.equal(updates.length, 0);

      const rowAfter = accounts.find(
        (candidate) => candidate.id === row.id,
      ) as SocialAccountRow;

      assert.equal(rowAfter.status, "CONNECTED");
      assert.ok(rowAfter.refreshToken);
    });
  });

  describe("fail-closed encryption", () => {
    it("refuses to persist refreshed tokens without an encryption key", async () => {
      const row = addConnectedAccount({
        accessTokenExpiresAt: new Date(Date.now() - 1000),
      });

      delete process.env[ENCRYPTION_KEY_ENV_VAR];

      const result = await lifecycle.refreshStoredTokens(
        row.id,
        "old-refresh-token",
        "TIKTOK",
      );

      assert.equal(result, null);
      assert.equal(updates.length, 0);
    });
  });
});
