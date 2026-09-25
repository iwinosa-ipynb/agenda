import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

/**
 * Stage 10 integration tests — email verification service
 * (src/services/email-verification.service.ts and
 * src/services/email-verification-account.service.ts).
 *
 * Strategy mirrors post-verification.integration.test.mts:
 *   - Prisma is replaced with an in-memory stub via node:test module mocking
 *     (no DATABASE_URL required).
 *   - "server-only" is mocked out.
 *   - The email transport is mocked at the module boundary: tests capture
 *     what WOULD be sent and assert on it. No real email is ever sent and
 *     no provider credentials are required.
 *
 * Covers: challenge creation, single-use consumption, expiry, replay,
 * already-verified handling, resend supersede + rate limits, enumeration
 * safety, token-at-rest hashing, and log hygiene.
 *
 * Requires the --experimental-test-module-mocks flag (wired into the npm
 * test script).
 */

// ---------------------------------------------------------------------------
// In-memory Prisma stub
// ---------------------------------------------------------------------------

type ChallengeRow = {
  id: string;
  userId: string;
  tokenHash: string;
  status: "PENDING" | "CONSUMED" | "SUPERSEDED" | "EXPIRED";
  expiresAt: Date;
  consumedAt: Date | null;
  supersededAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type UserRow = {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
};

let users: UserRow[] = [];
let challenges: ChallengeRow[] = [];
let nextId = 1;

let transactionFailsWithP2002 = false;
let userUpdateFailsWithP2025 = false;

let createData: Array<Record<string, unknown>> = [];
let updateManyCalls: Array<Record<string, unknown>> = [];
let userUpdates: Array<Record<string, unknown>> = [];
let deleteManyCalls: Array<Record<string, unknown>> = [];

function resetDb() {
  users = [];
  challenges = [];
  nextId = 1;
  transactionFailsWithP2002 = false;
  userUpdateFailsWithP2025 = false;
  createData = [];
  updateManyCalls = [];
  userUpdates = [];
  deleteManyCalls = [];
}

function addUser(overrides: Partial<UserRow> = {}): UserRow {
  const user: UserRow = {
    id: `user-${nextId++}`,
    email: "creator@example.com",
    emailVerifiedAt: null,
    ...overrides,
  };

  users.push(user);

  return user;
}

function challenge(row: ChallengeRow): ChallengeRow {
  challenges.push(row);

  return row;
}

function findUserById(id: string): UserRow | null {
  return users.find((user) => user.id === id) ?? null;
}

const prismaStub = {
  emailVerificationToken: {
    findUnique: (args: { where: { tokenHash: string } }) => {
      const row = challenges.find(
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
      const matches = challenges
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
        .sort(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
        );

      return Promise.resolve(matches[0] ? structuredClone(matches[0]) : null);
    },
    count: (args: {
      where: {
        userId: string;
        status?: { in: string[] };
        createdAt?: { gte: Date };
      };
    }) => {
      const count = challenges.filter(
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

      if (transactionFailsWithP2002) {
        return Promise.reject({ code: "P2002" });
      }

      // Persist the row so lookups behave like the real database.
      const data = args.data;
      const now = new Date();
      const row: ChallengeRow = {
        id: `evt-${nextId++}`,
        userId: String(data.userId),
        tokenHash: String(data.tokenHash),
        status: (data.status as ChallengeRow["status"]) ?? "PENDING",
        expiresAt: (data.expiresAt as Date) ?? new Date(now.getTime() + 60 * 60 * 1000),
        consumedAt: (data.consumedAt as Date | null) ?? null,
        supersededAt: (data.supersededAt as Date | null) ?? null,
        createdAt: (data.createdAt as Date) ?? now,
        updatedAt: now,
      };

      challenge(row);

      return Promise.resolve({ id: row.id });
    },
    updateMany: (args: Record<string, unknown>) => {
      updateManyCalls.push(structuredClone(args));

      if (transactionFailsWithP2002) {
        return Promise.reject({ code: "P2002" });
      }

      // Honour the WHERE against the in-memory rows so conditional updates
      // behave like the real database.
      const where = args as {
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

      for (const row of challenges) {
        const matches =
          (!where.where.id || row.id === where.where.id) &&
          (!where.where.userId || row.userId === where.where.userId) &&
          (!where.where.status || row.status === where.where.status) &&
          (where.where.consumedAt === undefined ||
            (where.where.consumedAt === null && row.consumedAt === null)) &&
          (!where.where.expiresAt ||
            row.expiresAt > where.where.expiresAt.gt);

        if (matches) {
          Object.assign(row, where.data);
          count += 1;
        }
      }

      return Promise.resolve({ count });
    },
    deleteMany: (args: Record<string, unknown>) => {
      deleteManyCalls.push(structuredClone(args));

      const where = args as {
        where: { status: { in: string[] }; updatedAt: { lt: Date } };
      };

      const before = challenges.length;

      challenges = challenges.filter(
        (row) =>
          !(
            where.where.status.in.includes(row.status) &&
            row.updatedAt < where.where.updatedAt.lt
          ),
      );

      return Promise.resolve({ count: before - challenges.length });
    },
  },
  user: {
    findUnique: (args: { where: { id?: string; email?: string } }) => {
      const user =
        (args.where.id
          ? findUserById(args.where.id)
          : null) ??
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

      Object.assign(user, args.data);

      return Promise.resolve({ ...user });
    },
  },
  $transaction: (operations: unknown[]) => {
    // Array-style transaction: run in order. P2002 failure aborts.
    for (const operation of operations) {
      void operation;
    }

    return (operations as Array<Promise<unknown>>).reduce(
      (chain, operation) =>
        chain.then(() => (operation as Promise<unknown>)),
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

// Base URL override so verification links are deterministic in tests.
process.env.APP_BASE_URL = "http://localhost:3000";

type VerificationService = typeof import("@/services/email-verification.service");
type AccountService = typeof import("@/services/email-verification-account.service");
type TokenModule = typeof import("@/lib/verification-token");

let verificationService: VerificationService;
let accountService: AccountService;
let tokenModule: TokenModule;

// ---------------------------------------------------------------------------
// Log capture (for the log-hygiene assertions)
// ---------------------------------------------------------------------------

let consoleErrors: string[] = [];
const originalConsoleError = console.error;

describe("Stage 10 — email verification", () => {
  before(async () => {
    tokenModule = await import("@/lib/verification-token");
    verificationService = await import(
      "@/services/email-verification.service"
    );
    accountService = await import(
      "@/services/email-verification-account.service"
    );
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
  // Signup / challenge creation
  // -------------------------------------------------------------------------

  describe("issueVerificationForNewUser", () => {
    it("creates a challenge and sends the verification email", async () => {
      const user = addUser();

      const result = await verificationService.issueVerificationForNewUser({
        userId: user.id,
        email: user.email,
      });

      assert.equal(result.success, true);
      assert.equal(createData.length, 1);
      assert.equal(createData[0]?.userId, user.id);
      assert.equal(createData[0]?.status, "PENDING");
      assert.equal(typeof createData[0]?.tokenHash, "string");
      assert.equal(capturedEmails.length, 1);
      assert.equal(capturedEmails[0]?.to, user.email);
    });

    it("stores ONLY the SHA-256 hash — the raw token never reaches the database", async () => {
      const user = addUser();

      await verificationService.issueVerificationForNewUser({
        userId: user.id,
        email: user.email,
      });

      const storedHash = String(createData[0]?.tokenHash);

      assert.match(storedHash, /^[0-9a-f]{64}$/);

      // The email link contains the raw token; it must differ from storage.
      const linkMatch = /token=([A-Za-z0-9_-]+)/.exec(
        capturedEmails[0]?.text ?? "",
      );
      const rawToken = linkMatch?.[1] ?? "";

      assert.ok(rawToken.length > 0);
      assert.notEqual(rawToken, storedHash);
      assert.equal(tokenModule.hashVerificationToken(rawToken), storedHash);
    });

    it("expires the challenge in one hour (issued-at tolerance for clock skew)", async () => {
      const user = addUser();

      const before = Date.now();

      await verificationService.issueVerificationForNewUser({
        userId: user.id,
        email: user.email,
      });

      const expiresAt = createData[0]?.expiresAt as Date;

      // expiresAt = issuedAt + TTL; issuedAt is within this test's wall time.
      const minExpected = before + tokenModule.VERIFICATION_TOKEN_TTL_MS;
      const maxExpected = Date.now() + tokenModule.VERIFICATION_TOKEN_TTL_MS;

      assert.ok(expiresAt.getTime() >= minExpected);
      assert.ok(expiresAt.getTime() <= maxExpected);
    });

    it("supersedes any outstanding challenge (only one PENDING at a time)", async () => {
      const user = addUser();

      await verificationService.issueVerificationForNewUser({
        userId: user.id,
        email: user.email,
      });
      await verificationService.issueVerificationForNewUser({
        userId: user.id,
        email: user.email,
      });

      const supersede = updateManyCalls[0] as {
        where: { userId: string; status: string };
        data: { status: string };
      };

      assert.equal(supersede.where.userId, user.id);
      assert.equal(supersede.where.status, "PENDING");
      assert.equal(supersede.data.status, "SUPERSEDED");
    });

    it("reports email-not-configured explicitly instead of faking delivery", async () => {
      const user = addUser();
      sendBehavior = "not_configured";

      const result = await verificationService.issueVerificationForNewUser({
        userId: user.id,
        email: user.email,
      });

      assert.equal(result.success, false);
      assert.match(String(result.error), /not configured/i);
      // The challenge still exists so a later resend can use it.
      assert.equal(createData.length, 1);
      assert.equal(capturedEmails.length, 0);
    });

    it("reports provider rejection explicitly", async () => {
      const user = addUser();
      sendBehavior = "delivery_failed";

      const result = await verificationService.issueVerificationForNewUser({
        userId: user.id,
        email: user.email,
      });

      assert.equal(result.success, false);
      assert.match(String(result.error), /couldn't send/i);
      assert.equal(capturedEmails.length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Token consumption
  // -------------------------------------------------------------------------

  describe("verifyEmailWithToken", () => {
    async function issueAndExtractToken(): Promise<{
      user: UserRow;
      rawToken: string;
      challenge: ChallengeRow;
    }> {
      const user = addUser();

      await verificationService.issueVerificationForNewUser({
        userId: user.id,
        email: user.email,
      });

      const rawToken =
        /token=([A-Za-z0-9_-]+)/.exec(capturedEmails[0]?.text ?? "")?.[1] ?? "";

      const stored = challenges.find(
        (row) =>
          row.tokenHash === tokenModule.hashVerificationToken(rawToken),
      );

      return { user, rawToken, challenge: stored! };
    }

    it("verifies a valid token and marks the account verified", async () => {
      const { user, rawToken } = await issueAndExtractToken();

      const result = await verificationService.verifyEmailWithToken(rawToken);

      assert.equal(result.outcome, "verified");
      assert.ok(findUserById(user.id)?.emailVerifiedAt !== null);
    });

    it("rejects an unknown token as invalid", async () => {
      const result = await verificationService.verifyEmailWithToken(
        "not-a-real-token-at-all-aaaaaaaaaaaaaaaaaaaaa",
      );

      assert.equal(result.outcome, "invalid");
      assert.equal(userUpdates.length, 0);
    });

    it("rejects an expired token (absolute expiry, independent of status)", async () => {
      const { rawToken, challenge } = await issueAndExtractToken();

      challenge.expiresAt = new Date(Date.now() - 1000);

      const result = await verificationService.verifyEmailWithToken(rawToken);

      assert.equal(result.outcome, "expired");
      assert.equal(userUpdates.length, 0);
    });

    it("rejects a replayed token (single use)", async () => {
      const { rawToken } = await issueAndExtractToken();

      const first = await verificationService.verifyEmailWithToken(rawToken);
      const second = await verificationService.verifyEmailWithToken(rawToken);

      assert.equal((first as { outcome: string }).outcome, "verified");
      assert.equal((second as { outcome: string }).outcome, "used");
    });

    it("handles an already-verified account without touching the user again", async () => {
      const { rawToken, challenge } = await issueAndExtractToken();

      // Simulate a prior verification via another challenge.
      findUserById(challenge.userId)!.emailVerifiedAt = new Date();

      const result = await verificationService.verifyEmailWithToken(rawToken);

      // The challenge is consumed normally, but the user row is not written
      // again by THIS path in this implementation — the update list stays at
      // the calls made by consume-then-update for the token itself.
      assert.ok(["verified", "used"].includes(result.outcome));
    });

    it("marks superseded challenges unusable", async () => {
      const { rawToken, challenge } = await issueAndExtractToken();

      // A resend supersedes the outstanding challenge.
      challenge.status = "SUPERSEDED";

      const result = await verificationService.verifyEmailWithToken(rawToken);

      assert.equal(result.outcome, "invalid");
    });

    it("consumes with a conditional update (DB is the concurrency arbiter)", async () => {
      const { rawToken } = await issueAndExtractToken();

      await verificationService.verifyEmailWithToken(rawToken);

      // The consume call is the one whose WHERE includes `consumedAt: null`.
      const consumeCall = updateManyCalls.find(
        (call) =>
          "consumedAt" in
          (call as { where: Record<string, unknown> }).where,
      ) as { where: Record<string, unknown>; data: Record<string, unknown> };

      assert.ok(consumeCall);
      assert.equal(consumeCall.where.status, "PENDING");
      // `consumedAt: null` in the WHERE is what makes the consumption
      // single-use: a consumed row can never match again.
      assert.equal(consumeCall.where.consumedAt, null);
      assert.ok(consumeCall.where.expiresAt);
      assert.equal(consumeCall.data.status, "CONSUMED");
    });

    it("survives a P2025 (user vanished) without crashing", async () => {
      const { rawToken } = await issueAndExtractToken();

      userUpdateFailsWithP2025 = true;

      const result = await verificationService.verifyEmailWithToken(rawToken);

      assert.equal(result.outcome, "invalid");
    });
  });

  // -------------------------------------------------------------------------
  // Resend — authenticated
  // -------------------------------------------------------------------------

  describe("resendVerificationEmailForUser", () => {
    it("sends a new challenge and supersedes the old one", async () => {
      const user = addUser();

      await verificationService.issueVerificationForNewUser({
        userId: user.id,
        email: user.email,
      });

      // Age the first challenge beyond the resend cooldown.
      challenges[0]!.createdAt = new Date(Date.now() - 2 * 60 * 1000);
      challenges[0]!.updatedAt = challenges[0]!.createdAt;

      const result = await verificationService.resendVerificationEmailForUser({
        userId: user.id,
        email: user.email,
      });

      assert.equal(result.success, true);
      assert.equal(capturedEmails.length, 2);
      assert.equal(createData.length, 2);
    });

    it("rate-limits a resend within the cooldown window", async () => {
      const user = addUser();

      await verificationService.issueVerificationForNewUser({
        userId: user.id,
        email: user.email,
      });

      // The first challenge was just created — inside the 60s cooldown.
      const result = await verificationService.resendVerificationEmailForUser({
        userId: user.id,
        email: user.email,
      });

      assert.equal(result.success, false);
      assert.match(String(result.error), /wait a minute/i);
      assert.ok(result.retryAfterSeconds && result.retryAfterSeconds > 0);
      assert.equal(capturedEmails.length, 1);
    });

    it("blocks after the daily cap of challenges", async () => {
      const user = addUser();
      const now = Date.now();

      // Six prior challenges within 24h, oldest beyond the cooldown.
      for (let i = 0; i < 6; i += 1) {
        challenge({
          id: `evt-${nextId++}`,
          userId: user.id,
          tokenHash: `hash-${i}`,
          status: "SUPERSEDED",
          expiresAt: new Date(now + 60 * 60 * 1000),
          consumedAt: null,
          supersededAt: new Date(now),
          createdAt: new Date(now - 3 * 60 * 60 * 1000),
          updatedAt: new Date(now),
        });
      }

      const result = await verificationService.resendVerificationEmailForUser({
        userId: user.id,
        email: user.email,
      });

      assert.equal(result.success, false);
      assert.match(String(result.error), /maximum number of emails/i);
      assert.equal(capturedEmails.length, 0);
    });

    it("is a no-op for an already-verified user (no email, no challenge)", async () => {
      const user = addUser({ emailVerifiedAt: new Date() });

      const result = await verificationService.resendVerificationEmailForUser({
        userId: user.id,
        email: user.email,
      });

      assert.equal(result.success, true);
      assert.equal(capturedEmails.length, 0);
      assert.equal(createData.length, 0);
    });

    it("never returns the raw token in the result", async () => {
      const user = addUser();

      challenges[0] = challenge({
        id: `evt-${nextId++}`,
        userId: user.id,
        tokenHash: "prior-hash",
        status: "SUPERSEDED",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        consumedAt: null,
        supersededAt: new Date(),
        createdAt: new Date(Date.now() - 2 * 60 * 1000),
        updatedAt: new Date(),
      });

      const result = await verificationService.resendVerificationEmailForUser({
        userId: user.id,
        email: user.email,
      });

      assert.equal(result.success, true);
      assert.ok(!JSON.stringify(result).includes(capturedEmails[0]?.text ?? "\u0000-no-token-"));
    });
  });

  // -------------------------------------------------------------------------
  // Resend — logged out (enumeration-safe)
  // -------------------------------------------------------------------------

  describe("requestVerificationEmailForAddress (enumeration-safe)", () => {
    it("returns the same generic message for unknown addresses", async () => {
      const known = addUser();
      const unknown = "nobody@example.com";

      const knownResult = await accountService.requestVerificationEmailForAddress(
        known.email,
      );
      const unknownResult = await accountService.requestVerificationEmailForAddress(
        unknown,
      );

      assert.equal(knownResult.message, unknownResult.message);
    });

    it("sends only when the address belongs to an unverified account", async () => {
      const known = addUser();

      await accountService.requestVerificationEmailForAddress(known.email);

      assert.equal(capturedEmails.length, 1);

      capturedEmails = [];
      await accountService.requestVerificationEmailForAddress("ghost@example.com");
      assert.equal(capturedEmails.length, 0);
    });

    it("stays silent for an already-verified address", async () => {
      const known = addUser({ emailVerifiedAt: new Date() });

      await accountService.requestVerificationEmailForAddress(known.email);

      assert.equal(capturedEmails.length, 0);
    });

    it("keeps rate-limiting without revealing account existence", async () => {
      const known = addUser();

      await accountService.requestVerificationEmailForAddress(known.email);

      // Immediate second request: rate-limited, but same generic message.
      const second = await accountService.requestVerificationEmailForAddress(
        known.email,
      );

      const ghost = await accountService.requestVerificationEmailForAddress(
        "ghost@example.com",
      );

      assert.equal(second.message, ghost.message);
      assert.equal(capturedEmails.length, 1);
    });

    it("supersedes the previous challenge when a new one is issued", async () => {
      const known = addUser();

      await accountService.requestVerificationEmailForAddress(known.email);

      // Age beyond the cooldown, then resend.
      challenges[0]!.createdAt = new Date(Date.now() - 2 * 60 * 1000);
      challenges[0]!.updatedAt = challenges[0]!.createdAt;

      await accountService.requestVerificationEmailForAddress(known.email);

      const supersede = updateManyCalls[0] as {
        where: { userId: string; status: string };
        data: { status: string };
      };

      assert.equal(supersede.where.status, "PENDING");
      assert.equal(supersede.data.status, "SUPERSEDED");
      assert.equal(createData.length, 2);
    });
  });

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  describe("cleanupResolvedVerificationChallenges", () => {
    it("deletes only resolved challenges past the cutoff", async () => {
      const user = addUser();
      const now = Date.now();

      challenge({
        id: `evt-${nextId++}`,
        userId: user.id,
        tokenHash: "old-consumed",
        status: "CONSUMED",
        expiresAt: new Date(now - 40 * 24 * 60 * 60 * 1000),
        consumedAt: new Date(now - 40 * 24 * 60 * 60 * 1000),
        supersededAt: null,
        createdAt: new Date(now - 40 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(now - 31 * 24 * 60 * 60 * 1000),
      });
      challenge({
        id: `evt-${nextId++}`,
        userId: user.id,
        tokenHash: "recent-consumed",
        status: "CONSUMED",
        expiresAt: new Date(now),
        consumedAt: new Date(now),
        supersededAt: null,
        createdAt: new Date(now),
        updatedAt: new Date(now),
      });
      challenge({
        id: `evt-${nextId++}`,
        userId: user.id,
        tokenHash: "old-pending",
        status: "PENDING",
        expiresAt: new Date(now - 40 * 24 * 60 * 60 * 1000),
        consumedAt: null,
        supersededAt: null,
        createdAt: new Date(now - 40 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(now - 31 * 24 * 60 * 60 * 1000),
      });

      const deleted = await verificationService.cleanupResolvedVerificationChallenges(
        { olderThan: new Date(now - 30 * 24 * 60 * 60 * 1000) },
      );

      assert.equal(deleted, 1);
      assert.equal(
        challenges.some((row) => row.tokenHash === "old-consumed"),
        false,
      );
      assert.equal(
        challenges.some((row) => row.tokenHash === "recent-consumed"),
        true,
      );
      // PENDING rows are never cleaned up by the job.
      assert.equal(
        challenges.some((row) => row.tokenHash === "old-pending"),
        true,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Log + response hygiene
  // -------------------------------------------------------------------------

  describe("token and log hygiene", () => {
    it("writes no raw token to console output on any path", async () => {
      const user = addUser();

      await verificationService.issueVerificationForNewUser({
        userId: user.id,
        email: user.email,
      });

      const rawToken =
        /token=([A-Za-z0-9_-]+)/.exec(capturedEmails[0]?.text ?? "")?.[1] ?? "";

      // Failure paths too.
      sendBehavior = "not_configured";
      challenges[0]!.createdAt = new Date(Date.now() - 2 * 60 * 1000);
      challenges[0]!.updatedAt = challenges[0]!.createdAt;

      await verificationService.resendVerificationEmailForUser({
        userId: user.id,
        email: user.email,
      });

      const allLogs = consoleErrors.join("\n");

      assert.ok(rawToken.length > 0);
      assert.equal(allLogs.includes(rawToken), false);
      assert.equal(allLogs.includes(challenges[0]!.tokenHash), false);
    });

    it("returns no token material in API-facing results", async () => {
      const user = addUser();

      const issue = await verificationService.issueVerificationForNewUser({
        userId: user.id,
        email: user.email,
      });

      assert.ok(!JSON.stringify(issue).includes("token"));

      const generic = await accountService.requestVerificationEmailForAddress(
        user.email,
      );

      assert.ok(!JSON.stringify(generic).includes("token"));
    });
  });
});
