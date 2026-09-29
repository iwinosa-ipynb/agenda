import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";
import { compare, hash } from "bcryptjs";

/**
 * Forgot Password integration tests — password-reset service
 * (src/services/password-reset.service.ts).
 *
 * Strategy mirrors email-verification.integration.test.mts:
 *   - Prisma is replaced with an in-memory stub via node:test module mocking
 *     (no DATABASE_URL required).
 *   - "server-only" is mocked out.
 *   - The email transport is mocked at the module boundary: tests capture
 *     what WOULD be sent and assert on it. No real email is ever sent and
 *     no provider credentials are required.
 *   - bcryptjs is REAL (pure JS): password-replacement assertions exercise
 *     the production hashing/compare path.
 *
 * Requires the --experimental-test-module-mocks flag (wired into the npm
 * test script).
 */

// ---------------------------------------------------------------------------
// In-memory Prisma stub
// ---------------------------------------------------------------------------

type ResetRow = {
  id: string;
  userId: string;
  tokenHash: string;
  status: "PENDING" | "CONSUMED" | "SUPERSEDED";
  expiresAt: Date;
  consumedAt: Date | null;
  supersededAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type UserRow = {
  id: string;
  email: string;
  passwordHash: string;
  sessionVersion: number;
};

let users: UserRow[] = [];
let resets: ResetRow[] = [];
let nextId = 1;

let userUpdateFailsWithP2025 = false;

let createData: Array<Record<string, unknown>> = [];
let updateManyCalls: Array<Record<string, unknown>> = [];
let userUpdates: Array<Record<string, unknown>> = [];

function resetDb() {
  users = [];
  resets = [];
  nextId = 1;
  userUpdateFailsWithP2025 = false;
  createData = [];
  updateManyCalls = [];
  userUpdates = [];
}

function addUser(overrides: Partial<UserRow> = {}): UserRow {
  const user: UserRow = {
    id: `user-${nextId++}`,
    email: "creator@example.com",
    // bcrypt-format placeholder; tests that assert on compare() seed a real
    // hash explicitly via the overrides.
    passwordHash:
      "$2a$12$C6UzMDM.H6dfI/f/IKcEe.ORhGO8uRfOu1lHqBQPWmfWQmFQG2FSy",
    sessionVersion: 0,
    ...overrides,
  };

  users.push(user);

  return user;
}

function findUserById(id: string): UserRow | null {
  return users.find((user) => user.id === id) ?? null;
}

const prismaStub = {
  passwordResetToken: {
    findUnique: (args: { where: { tokenHash: string } }) => {
      const row = resets.find(
        (candidate) => candidate.tokenHash === args.where.tokenHash,
      );

      return Promise.resolve(row ? structuredClone(row) : null);
    },
    findFirst: (args: {
      where: {
        userId: string;
        status?: string | { in: string[] };
        createdAt?: { gte: Date };
      };
    }) => {
      const matches = resets
        .filter(
          (candidate) =>
            candidate.userId === args.where.userId &&
            (!args.where.status ||
              (typeof args.where.status === "string"
                ? candidate.status === args.where.status
                : args.where.status.in.includes(candidate.status))) &&
            (!args.where.createdAt ||
              candidate.createdAt >= args.where.createdAt.gte),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

      return Promise.resolve(matches[0] ? structuredClone(matches[0]) : null);
    },
    count: (args: {
      where: {
        userId: string;
        status?: { in: string[] };
        createdAt?: { gte: Date };
      };
    }) => {
      const count = resets.filter(
        (candidate) =>
          candidate.userId === args.where.userId &&
          (!args.where.status ||
            args.where.status.in.includes(candidate.status)) &&
          (!args.where.createdAt ||
            candidate.createdAt >= args.where.createdAt.gte),
      ).length;

      return Promise.resolve(count);
    },
    create: (args: { data: Record<string, unknown> }) => {
      createData.push(structuredClone(args.data));

      // Persist the row so lookups behave like the real database.
      const data = args.data;
      const now = new Date();
      const row: ResetRow = {
        id: `prt-${nextId++}`,
        userId: String(data.userId),
        tokenHash: String(data.tokenHash),
        status: (data.status as ResetRow["status"]) ?? "PENDING",
        expiresAt:
          (data.expiresAt as Date) ?? new Date(now.getTime() + 30 * 60 * 1000),
        consumedAt: (data.consumedAt as Date | null) ?? null,
        supersededAt: (data.supersededAt as Date | null) ?? null,
        createdAt: (data.createdAt as Date) ?? now,
        updatedAt: now,
      };

      resets.push(row);

      return Promise.resolve({ id: row.id });
    },
    updateMany: (args: Record<string, unknown>) => {
      updateManyCalls.push(structuredClone(args));

      // Honour the WHERE against the in-memory rows so conditional updates
      // behave like the real database.
      const { where, data } = args as {
        where: {
          id?: string;
          userId?: string;
          status?: string;
          consumedAt?: unknown;
          expiresAt?: { gt: Date };
        };
        data: Record<string, unknown>;
      };

      let count = 0;

      for (const row of resets) {
        const matches =
          (!where.id || row.id === where.id) &&
          (!where.userId || row.userId === where.userId) &&
          (!where.status || row.status === where.status) &&
          (where.consumedAt === undefined ||
            (where.consumedAt === null && row.consumedAt === null)) &&
          (!where.expiresAt || row.expiresAt > where.expiresAt.gt);

        if (matches) {
          Object.assign(row, structuredClone(data));
          count += 1;
        }
      }

      return Promise.resolve({ count });
    },
  },
  user: {
    findUnique: (args: { where: { id?: string; email?: string } }) => {
      const user =
        (args.where.id ? findUserById(args.where.id) : null) ??
        (args.where.email
          ? (users.find((candidate) => candidate.email === args.where.email) ??
            null)
          : null);

      return Promise.resolve(user ? { ...user } : null);
    },
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => {
      userUpdates.push(structuredClone(args));

      if (userUpdateFailsWithP2025) {
        return Promise.reject({ code: "P2025" });
      }

      const user = findUserById(args.where.id);

      if (!user) {
        return Promise.reject({ code: "P2025" });
      }

      const data = args.data;

      if (typeof data.passwordHash === "string") {
        user.passwordHash = data.passwordHash;
      }

      if (
        data.sessionVersion &&
        typeof data.sessionVersion === "object" &&
        "increment" in (data.sessionVersion as Record<string, unknown>)
      ) {
        user.sessionVersion += Number(
          (data.sessionVersion as { increment: number }).increment,
        );
      } else if (typeof data.sessionVersion === "number") {
        user.sessionVersion = data.sessionVersion;
      }

      return Promise.resolve({ ...user });
    },
  },
  $transaction: (operations: unknown[]) => {
    // Array-style transaction: run in order. P2002 failure aborts.
    for (const operation of operations) {
      void operation;
    }

    return (operations as Array<Promise<unknown>>).reduce(
      (chain, operation) => chain.then(() => operation as Promise<unknown>),
      Promise.resolve() as Promise<unknown>,
    );
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

// Capture emails instead of sending them. Never a fake sender in production
// code — this is the TEST transport.
let capturedEmails: Array<{
  to: string;
  subject: string;
  text: string;
  html: string;
}> = [];
let sendBehavior: "ok" | "not_configured" | "delivery_failed" = "ok";

// The SAME classes the service imports, so `instanceof` behaves exactly as
// it does in production.
class FakeEmailNotConfiguredError extends Error {
  constructor() {
    super("EMAIL_PROVIDER is not configured on this server.");
    this.name = "EmailNotConfiguredError";
  }
}

class FakeEmailDeliveryError extends Error {
  constructor() {
    super("Email provider rejected the message.");
    this.name = "EmailDeliveryError";
  }
}

function resetEmailCapture() {
  capturedEmails = [];
  sendBehavior = "ok";
}

mockModule("@/lib/email/email-service", {
  EmailNotConfiguredError: FakeEmailNotConfiguredError,
  EmailDeliveryError: FakeEmailDeliveryError,
  isEmailConfigured: () => sendBehavior === "ok",
  sendEmail: (email: { to: string; subject: string; text: string; html: string }) => {
    if (sendBehavior === "not_configured") {
      return Promise.reject(new FakeEmailNotConfiguredError());
    }

    if (sendBehavior === "delivery_failed") {
      return Promise.reject(new FakeEmailDeliveryError());
    }

    capturedEmails.push({ ...email });

    return Promise.resolve({ providerMessageId: "test-message-id" });
  },
});

// Base URL override so reset links are deterministic in tests.
process.env.APP_BASE_URL = "http://localhost:3000";

type VerificationTokenModule = typeof import("@/lib/verification-token");
type ResetTokenModule = typeof import("@/lib/password-reset-token");
type ResetService = typeof import("@/services/password-reset.service");

let verificationTokenModule: VerificationTokenModule;
let resetTokenModule: ResetTokenModule;
let passwordResetService: ResetService;

// ---------------------------------------------------------------------------
// Log capture (for the log-hygiene assertions)
// ---------------------------------------------------------------------------

let consoleErrors: string[] = [];
const originalConsoleError = console.error;

describe("Forgot Password — password reset", () => {
  before(async () => {
    verificationTokenModule = await import("@/lib/verification-token");
    resetTokenModule = await import("@/lib/password-reset-token");
    passwordResetService = await import("@/services/password-reset.service");
  });

  beforeEach(() => {
    resetDb();
    resetEmailCapture();
    consoleErrors = [];
    console.error = (...parts: unknown[]) => {
      consoleErrors.push(parts.map(String).join(" "));
    };
  });

  // Restore after the suite; node:test also undoes per-test mocks.
  it("restores console.error at the end", () => {
    console.error = originalConsoleError;
    assert.ok(true);
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function extractRawToken(text: string): string {
    return /token=([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? "";
  }

  async function issueAndExtractToken(): Promise<{
    user: UserRow;
    rawToken: string;
    row: ResetRow;
  }> {
    const user = addUser();

    await passwordResetService.requestPasswordResetForAddress(user.email);

    const rawToken = extractRawToken(capturedEmails[0]?.text ?? "");

    const row =
      resets.find(
        (candidate) =>
          candidate.tokenHash ===
          resetTokenModule.hashPasswordResetToken(rawToken),
      ) ?? resets[0]!;

    return { user, rawToken, row };
  }

  // -------------------------------------------------------------------------
  // Request: enumeration safety + issuance
  // -------------------------------------------------------------------------

  describe("requestPasswordResetForAddress (enumeration-safe)", () => {
    it("returns the same generic message for known and unknown addresses", async () => {
      const known = addUser();

      const knownResult =
        await passwordResetService.requestPasswordResetForAddress(known.email);
      const unknownResult =
        await passwordResetService.requestPasswordResetForAddress(
          "nobody@example.com",
        );

      assert.equal(knownResult.message, unknownResult.message);
      assert.match(knownResult.message, /If an account exists/i);
    });

    it("creates a PENDING token and sends the reset email for a registered address", async () => {
      const user = addUser();

      await passwordResetService.requestPasswordResetForAddress(user.email);

      assert.equal(createData.length, 1);
      assert.equal(createData[0]?.userId, user.id);
      assert.equal(createData[0]?.status, "PENDING");
      assert.equal(capturedEmails.length, 1);
      assert.equal(capturedEmails[0]?.to, user.email);
      assert.match(String(capturedEmails[0]?.subject), /reset your password/i);
    });

    it("does nothing observable for an unknown address (no token, no email)", async () => {
      await passwordResetService.requestPasswordResetForAddress(
        "ghost@example.com",
      );

      assert.equal(createData.length, 0);
      assert.equal(capturedEmails.length, 0);
    });

    it("stores ONLY the SHA-256 hash — the raw token never reaches the database", async () => {
      const user = addUser();

      await passwordResetService.requestPasswordResetForAddress(user.email);

      const storedHash = String(createData[0]?.tokenHash);

      assert.match(storedHash, /^[0-9a-f]{64}$/);

      // The email link contains the raw token; it must differ from storage
      // and hash to exactly the stored value.
      const rawToken = extractRawToken(capturedEmails[0]?.text ?? "");

      assert.ok(rawToken.length > 0);
      assert.notEqual(rawToken, storedHash);
      assert.equal(resetTokenModule.hashPasswordResetToken(rawToken), storedHash);
    });

    it("expires the reset link in 30 minutes (shorter than verification's 60)", async () => {
      const user = addUser();
      const before = Date.now();

      await passwordResetService.requestPasswordResetForAddress(user.email);

      const expiresAt = createData[0]?.expiresAt as Date;

      const minExpected = before + resetTokenModule.PASSWORD_RESET_TOKEN_TTL_MS;
      const maxExpected = Date.now() + resetTokenModule.PASSWORD_RESET_TOKEN_TTL_MS;

      assert.ok(expiresAt.getTime() >= minExpected);
      assert.ok(expiresAt.getTime() <= maxExpected);
      assert.ok(
        resetTokenModule.PASSWORD_RESET_TOKEN_TTL_MS <
          verificationTokenModule.VERIFICATION_TOKEN_TTL_MS,
      );
    });

    it("supersedes the previous outstanding token when a new request is issued", async () => {
      const user = addUser();

      await passwordResetService.requestPasswordResetForAddress(user.email);

      // Age the first request beyond the 60s cooldown, then request again.
      resets[0]!.createdAt = new Date(Date.now() - 2 * 60 * 1000);
      resets[0]!.updatedAt = resets[0]!.createdAt;

      await passwordResetService.requestPasswordResetForAddress(user.email);

      const supersede = updateManyCalls[0] as {
        where: { userId: string; status: string };
        data: { status: string };
      };

      assert.equal(supersede.where.userId, user.id);
      assert.equal(supersede.where.status, "PENDING");
      assert.equal(supersede.data.status, "SUPERSEDED");
      assert.equal(createData.length, 2);
    });

    it("rate-limits an immediate second request but keeps the generic message", async () => {
      const known = addUser();

      await passwordResetService.requestPasswordResetForAddress(known.email);

      const second = await passwordResetService.requestPasswordResetForAddress(
        known.email,
      );
      const ghost =
        await passwordResetService.requestPasswordResetForAddress(
          "ghost@example.com",
        );

      // Rate-limited response is IDENTICAL to the unknown-address response,
      // so throttling cannot confirm account existence either.
      assert.equal(second.message, ghost.message);
      assert.equal(createData.length, 1);
      assert.equal(capturedEmails.length, 1);
    });

    it("keeps the challenge PENDING and returns the generic message when email is unconfigured", async () => {
      const user = addUser();
      sendBehavior = "not_configured";

      const result = await passwordResetService.requestPasswordResetForAddress(
        user.email,
      );

      // Generic to the client; operator reason in the console log only.
      assert.match(result.message, /If an account exists/i);
      assert.equal(createData.length, 1);
      assert.equal(capturedEmails.length, 0);
      assert.match(consoleErrors.join("\n"), /not configured/i);
    });

    it("returns the generic message on provider rejection (reason logged only)", async () => {
      const user = addUser();
      sendBehavior = "delivery_failed";

      const result = await passwordResetService.requestPasswordResetForAddress(
        user.email,
      );

      assert.match(result.message, /If an account exists/i);
      assert.equal(capturedEmails.length, 0);
    });

    it("never writes the raw token to console output on any path", async () => {
      const user = addUser();

      await passwordResetService.requestPasswordResetForAddress(user.email);

      const rawToken = extractRawToken(capturedEmails[0]?.text ?? "");

      // Failure paths too.
      sendBehavior = "not_configured";
      resets[0]!.createdAt = new Date(Date.now() - 2 * 60 * 1000);
      resets[0]!.updatedAt = resets[0]!.createdAt;

      await passwordResetService.requestPasswordResetForAddress(user.email);

      const allLogs = consoleErrors.join("\n");

      assert.ok(rawToken.length > 0);
      assert.equal(allLogs.includes(rawToken), false);
      assert.equal(allLogs.includes(String(createData[0]?.tokenHash)), false);
    });

    it("allows unverified users to reset through their registered email", async () => {
      // The stub's user rows carry no verification state at all — the
      // request path never consults it. Possession of the inbox is the
      // proof, exactly as the verification flow reasons.
      const user = addUser({ sessionVersion: 0 });

      await passwordResetService.requestPasswordResetForAddress(user.email);

      assert.equal(createData.length, 1);
      assert.equal(capturedEmails.length, 1);
      assert.equal(capturedEmails[0]?.to, user.email);
    });
  });

  // -------------------------------------------------------------------------
  // Consume: validation, replacement, single use
  // -------------------------------------------------------------------------

  describe("resetPasswordWithToken", () => {
    it("replaces the password with a fresh bcrypt hash and reports reset", async () => {
      const { user, rawToken } = await issueAndExtractToken();

      const oldHash = findUserById(user.id)!.passwordHash;

      const result = await passwordResetService.resetPasswordWithToken(
        rawToken,
        "brand-new-password-99",
      );

      assert.equal(result.outcome, "reset");

      const updated = findUserById(user.id)!;

      assert.notEqual(updated.passwordHash, oldHash);
      assert.match(updated.passwordHash, /^\$2[aby]\$\d{2}\$/);
    });

    it("makes the new password verify and the old password fail (bcrypt)", async () => {
      // Seed a REAL bcrypt hash so compare() assertions are honest.
      const realOldHash = await hash("original-password-1", 12);
      const user = addUser({ passwordHash: realOldHash });

      await passwordResetService.requestPasswordResetForAddress(user.email);

      const rawToken = extractRawToken(capturedEmails[0]?.text ?? "");

      const result = await passwordResetService.resetPasswordWithToken(
        rawToken,
        "fresh-password-42",
      );

      assert.equal(result.outcome, "reset");

      const newHash = findUserById(user.id)!.passwordHash;

      assert.equal(await compare("fresh-password-42", newHash), true);
      assert.equal(await compare("original-password-1", newHash), false);
    });

    it("bumps sessionVersion so existing JWT sessions are invalidated", async () => {
      const { user, rawToken } = await issueAndExtractToken();

      assert.equal(findUserById(user.id)!.sessionVersion, 0);

      await passwordResetService.resetPasswordWithToken(
        rawToken,
        "another-pw-123",
      );

      assert.equal(findUserById(user.id)!.sessionVersion, 1);
    });

    it("consumes with a conditional update (DB is the concurrency arbiter)", async () => {
      const { rawToken } = await issueAndExtractToken();

      await passwordResetService.resetPasswordWithToken(rawToken, "some-pw-1234");

      // The consume call is the one whose WHERE includes `consumedAt: null`.
      const consumeCall = updateManyCalls.find(
        (call) =>
          "consumedAt" in
          (call as { where: Record<string, unknown> }).where,
      ) as { where: Record<string, unknown>; data: Record<string, unknown> };

      assert.ok(consumeCall);
      assert.equal(consumeCall.where.status, "PENDING");
      // `consumedAt: null` in the WHERE is what makes consumption single-use:
      // a consumed row can never match again.
      assert.equal(consumeCall.where.consumedAt, null);
      assert.ok(consumeCall.where.expiresAt);
      assert.equal(consumeCall.data.status, "CONSUMED");
    });

    it("is single-use: a replayed token reports used and never rewrites the password", async () => {
      const { user, rawToken } = await issueAndExtractToken();

      const first = await passwordResetService.resetPasswordWithToken(
        rawToken,
        "first-new-pw-11",
      );
      const hashAfterFirst = findUserById(user.id)!.passwordHash;

      const second = await passwordResetService.resetPasswordWithToken(
        rawToken,
        "second-new-pw-22",
      );

      assert.equal(first.outcome, "reset");
      assert.equal(second.outcome, "used");
      assert.equal(findUserById(user.id)!.passwordHash, hashAfterFirst);
    });

    it("handles concurrent consumption: exactly one of two parallel requests wins", async () => {
      const { rawToken } = await issueAndExtractToken();

      const [first, second] = await Promise.all([
        passwordResetService.resetPasswordWithToken(rawToken, "pw-alpha-111"),
        passwordResetService.resetPasswordWithToken(rawToken, "pw-beta-2222"),
      ]);

      const outcomes = [first.outcome, second.outcome].sort();

      // Exactly one "reset" — the loser reports "used" (conditional update
      // matched zero rows), never "invalid" and never two successes.
      assert.deepEqual(outcomes, ["reset", "used"]);
      assert.equal(userUpdates.length, 1);
    });

    it("rejects an unknown token as invalid without touching any user", async () => {
      const user = addUser();

      const result = await passwordResetService.resetPasswordWithToken(
        "not-a-real-token-at-all-aaaaaaaaaaaaaaaaaaaaa",
        "whatever-pw-123",
      );

      assert.equal(result.outcome, "invalid");
      assert.equal(userUpdates.length, 0);
      assert.equal(findUserById(user.id)!.sessionVersion, 0);
    });

    it("rejects an expired token (absolute expiry, independent of status)", async () => {
      const { user, rawToken, row } = await issueAndExtractToken();

      row.expiresAt = new Date(Date.now() - 1000);

      const result = await passwordResetService.resetPasswordWithToken(
        rawToken,
        "some-pw-1234",
      );

      assert.equal(result.outcome, "expired");
      assert.equal(userUpdates.length, 0);
      assert.equal(findUserById(user.id)!.passwordHash, user.passwordHash);
    });

    it("rejects a superseded token as invalid", async () => {
      const { user, rawToken, row } = await issueAndExtractToken();

      row.status = "SUPERSEDED";

      const result = await passwordResetService.resetPasswordWithToken(
        rawToken,
        "some-pw-1234",
      );

      assert.equal(result.outcome, "invalid");
      assert.equal(findUserById(user.id)!.passwordHash, user.passwordHash);
    });

    it("rejects a policy-violating password without burning the token", async () => {
      const { rawToken } = await issueAndExtractToken();

      const result = await passwordResetService.resetPasswordWithToken(
        rawToken,
        "short",
      );

      assert.equal(result.outcome, "invalid");
      assert.equal(userUpdates.length, 0);

      // The token is still consumable afterwards with a valid password.
      const retry = await passwordResetService.resetPasswordWithToken(
        rawToken,
        "valid-password-1",
      );

      assert.equal(retry.outcome, "reset");
    });

    it("survives a P2025 (user vanished) without crashing", async () => {
      const { rawToken } = await issueAndExtractToken();

      userUpdateFailsWithP2025 = true;

      const result = await passwordResetService.resetPasswordWithToken(
        rawToken,
        "some-pw-1234",
      );

      assert.equal(result.outcome, "invalid");
    });
  });

  // -------------------------------------------------------------------------
  // Token inspection (reset page initial state)
  // -------------------------------------------------------------------------

  describe("inspectPasswordResetToken", () => {
    it("reports missing for a null/empty token", async () => {
      assert.equal(
        (await passwordResetService.inspectPasswordResetToken(null)).state,
        "missing",
      );
      assert.equal(
        (await passwordResetService.inspectPasswordResetToken("")).state,
        "missing",
      );
    });

    it("reports invalid for an unknown token", async () => {
      assert.equal(
        (
          await passwordResetService.inspectPasswordResetToken(
            "not-a-real-token-at-all-aaaaaaaaaaaaaaaaaaaaa",
          )
        ).state,
        "invalid",
      );
    });

    it("reports expired for a past-expiry token", async () => {
      const { rawToken, row } = await issueAndExtractToken();

      row.expiresAt = new Date(Date.now() - 1000);

      assert.equal(
        (await passwordResetService.inspectPasswordResetToken(rawToken)).state,
        "expired",
      );
    });

    it("reports used for a consumed token", async () => {
      const { rawToken } = await issueAndExtractToken();

      await passwordResetService.resetPasswordWithToken(
        rawToken,
        "used-up-pw-11",
      );

      assert.equal(
        (await passwordResetService.inspectPasswordResetToken(rawToken)).state,
        "used",
      );
    });

    it("reports valid for a fresh PENDING token WITHOUT consuming it", async () => {
      const { rawToken, row } = await issueAndExtractToken();

      assert.equal(
        (await passwordResetService.inspectPasswordResetToken(rawToken)).state,
        "valid",
      );
      // Inspection must not consume the challenge.
      assert.equal(row.status, "PENDING");
      assert.equal(row.consumedAt, null);
    });
  });
});
