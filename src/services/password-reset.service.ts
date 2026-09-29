import "server-only";

import { hash } from "bcryptjs";

import {
  EmailDeliveryError,
  EmailNotConfiguredError,
  sendEmail,
} from "@/lib/email/email-service";
import {
  buildPasswordResetUrl,
  renderPasswordResetEmail,
} from "@/lib/email/password-reset-email";
import { isNotFoundError, isUniqueConstraintError } from "@/lib/prisma-errors";
import { prisma } from "@/lib/prisma";
import {
  evaluatePasswordResetRateLimit,
  hashPasswordResetToken,
  isPasswordResetExpired,
  passwordResetExpiryFrom,
  generatePasswordResetToken,
} from "@/lib/password-reset-token";
import { passwordSchema } from "@/validation/auth";

/**
 * Password-reset service (Forgot Password).
 *
 * Mirrors the Stage 10 email-verification service exactly:
 *  - At most ONE PENDING challenge per user (DB-enforced via the
 *    (userId, status) unique index). A new request supersedes the previous one.
 *  - Only the SHA-256 hash of a token is stored; the raw token is returned
 *    exactly once by `issuePasswordReset` so the caller can email it, and is
 *    never logged, never stored, never sent to the client.
 *  - Consumption is a single conditional UPDATE (`status: "PENDING"` +
 *    `consumedAt: null` + unexpired in the WHERE) — the database is the
 *    concurrency arbiter, so two parallel submissions cannot both succeed.
 *  - Enumeration-safe: every function that answers a client-facing request
 *    returns a generic, safe result whether or not the account exists.
 *  - A successful reset bumps User.sessionVersion so the JWT callback
 *    invalidates existing sessions on other devices (JWT invalidation seam —
 *    the reset write itself never has to know about JWTs).
 */

// ---------------------------------------------------------------------------
// Issue: create a challenge and send the email
// ---------------------------------------------------------------------------

async function issuePasswordReset(input: {
  userId: string;
  email: string;
}): Promise<
  | { ok: true; rawToken: string }
  | { ok: false; reason: "email_not_configured" | "delivery_failed" }
> {
  const rawToken = generatePasswordResetToken();
  const tokenHash = hashPasswordResetToken(rawToken);
  const issuedAt = new Date();

  try {
    // Supersede any outstanding challenge first so the (userId, status)
    // unique index never rejects the new PENDING row.
    await prisma.$transaction([
      prisma.passwordResetToken.updateMany({
        where: { userId: input.userId, status: "PENDING" },
        data: { status: "SUPERSEDED", supersededAt: issuedAt },
      }),
      prisma.passwordResetToken.create({
        data: {
          userId: input.userId,
          tokenHash,
          status: "PENDING",
          expiresAt: passwordResetExpiryFrom(issuedAt),
        },
      }),
    ]);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      // Losing a race against another issuer is fine: that issuer's
      // challenge is the outstanding one. Nothing leaked; just report.
      return { ok: false, reason: "delivery_failed" };
    }

    throw error;
  }

  const url = buildPasswordResetUrl(rawToken);
  const email = renderPasswordResetEmail({
    recipientEmail: input.email,
    resetUrl: url,
  });

  try {
    await sendEmail(email);
  } catch (error) {
    // The challenge stays PENDING so a retry can use it once email works;
    // the token itself is never exposed to the client.
    if (error instanceof EmailNotConfiguredError) {
      console.error(
        "password-reset: send skipped —",
        (error as Error).message,
      );
      return { ok: false, reason: "email_not_configured" };
    }

    if (error instanceof EmailDeliveryError) {
      console.error(
        "password-reset: send failed with provider status",
        (error as EmailDeliveryError).status,
      );
      return { ok: false, reason: "delivery_failed" };
    }

    throw error;
  }

  return { ok: true, rawToken };
}

// ---------------------------------------------------------------------------
// Request (enumeration-safe entry point, mirrors
// requestVerificationEmailForAddress)
// ---------------------------------------------------------------------------

/** Generic message returned regardless of account existence. */
export const GENERIC_PASSWORD_RESET_MESSAGE =
  "If an account exists for that email, you'll receive a password reset link shortly.";

const RESEND_WINDOW_MS = 24 * 60 * 60 * 1000;

export type SafeResetOutcome = {
  /** Always the same generic message, whether or not the account exists. */
  message: string;
  retryAfterSeconds?: number;
};

/**
 * Request a password reset for an arbitrary email address
 * (enumeration-safe). Used by the logged-out forgot-password form.
 *
 * Unverified accounts are allowed: the reset link is sent ONLY to the
 * address already stored on the account, so possession of the inbox is the
 * ownership proof — same reasoning as the verification flow.
 */
export async function requestPasswordResetForAddress(
  rawEmail: string,
): Promise<SafeResetOutcome> {
  const email = rawEmail.trim().toLowerCase();
  const generic = { message: GENERIC_PASSWORD_RESET_MESSAGE };

  if (!email) {
    return generic;
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (!user) {
    // Unknown address: do exactly nothing and return the same message.
    return generic;
  }

  const windowStart = new Date(Date.now() - RESEND_WINDOW_MS);

  const [newest, recentCount] = await Promise.all([
    prisma.passwordResetToken.findFirst({
      where: { userId: user.id, createdAt: { gte: windowStart } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.passwordResetToken.count({
      where: {
        userId: user.id,
        createdAt: { gte: windowStart },
        status: { in: ["PENDING", "CONSUMED", "SUPERSEDED"] },
      },
    }),
  ]);

  const decision = evaluatePasswordResetRateLimit(
    new Date(),
    newest?.createdAt ?? null,
    recentCount,
  );

  if (!decision.allowed) {
    // Rate-limited: STILL return the generic message. We must not confirm
    // account existence via a different error, but we do keep the throttle.
    return {
      ...generic,
      retryAfterSeconds:
        decision.reason === "min_interval"
          ? 60
          : Math.ceil(RESEND_WINDOW_MS / 1000),
    };
  }

  const issued = await issuePasswordReset({ userId: user.id, email });

  if (!issued.ok && issued.reason === "email_not_configured") {
    // Operator-visible failure without leaking account existence: the
    // message stays generic, the console gets the reason.
    console.error(
      "password-reset: request skipped —",
      "email not configured",
    );
  }

  return generic;
}

// ---------------------------------------------------------------------------
// Consume: validate token, replace password, invalidate sessions
// ---------------------------------------------------------------------------

export type PasswordResetOutcome =
  | "reset" // token valid and consumed in this call; password replaced
  | "expired" // token past its absolute expiry
  | "used" // token already consumed (replay attempt)
  | "invalid"; // unknown token

/** Public-safe description of a reset attempt — never echoes tokens. */
export type PasswordResetResult =
  | { outcome: "reset"; message: string }
  | { outcome: "expired"; message: string }
  | { outcome: "used"; message: string }
  | { outcome: "invalid"; message: string };

/**
 * Classify a stored challenge. Expiry is checked against the absolute
 * timestamp, NOT just the status column, so an un-expired-status row can
 * never be used after its deadline even if cleanup has not run yet.
 */
function classifyChallenge(challenge: {
  status: string;
  expiresAt: Date;
}): "invalid" | "expired" | "used" | "valid" {
  const now = new Date();

  if (isPasswordResetExpired(challenge.expiresAt, now)) {
    return "expired";
  }

  if (challenge.status === "CONSUMED") {
    return "used";
  }

  return challenge.status === "PENDING" ? "valid" : "invalid";
}

/**
 * Reset the password with a valid, unconsumed, unexpired token. This is the
 * only path that writes User.passwordHash outside registration/login, and it
 * is entirely server-side.
 *
 * Concurrency: the token consumption is a single conditional UPDATE whose
 * WHERE requires the row to still be PENDING/unconsumed/unexpired. If two
 * requests race, exactly one wins (count === 1); the loser reports "used"
 * and never writes the password.
 */
export async function resetPasswordWithToken(
  rawToken: string,
  newPassword: string,
): Promise<PasswordResetResult> {
  const trimmed = rawToken.trim();

  if (!trimmed) {
    return {
      outcome: "invalid",
      message: "This password reset link is not valid.",
    };
  }

  // Reuse the shared password policy — no duplicate policy lives here.
  const parsed = passwordSchema.safeParse(newPassword);

  if (!parsed.success) {
    return {
      outcome: "invalid",
      message: "This password reset link is not valid.",
    };
  }

  // Pre-check with bcrypt's 72-byte limit in mind: hash AFTER validation so
  // a malformed password can never burn a valid token's single use.
  const passwordHash = await hash(parsed.data, 12);

  const tokenHash = hashPasswordResetToken(trimmed);

  const challenge = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
  });

  if (!challenge) {
    return {
      outcome: "invalid",
      message: "This password reset link is not valid.",
    };
  }

  const classification = classifyChallenge(challenge);

  if (classification === "expired") {
    return {
      outcome: "expired",
      message:
        "This password reset link has expired. Request a new one from the forgot-password page.",
    };
  }

  if (classification === "used") {
    return {
      outcome: "used",
      message:
        "This link has already been used. If you didn't just reset your password, request a new one from the forgot-password page.",
    };
  }

  if (classification !== "valid") {
    return {
      outcome: "invalid",
      message: "This password reset link is not valid.",
    };
  }

  // Single-use enforcement: the WHERE clause requires the row to still be
  // PENDING, unconsumed, and unexpired. If another request consumed it
  // first, update matches zero rows and we report the link as used — the
  // password write below only ever happens for the single winner.
  const consumed = await prisma.passwordResetToken.updateMany({
    where: {
      id: challenge.id,
      status: "PENDING",
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: {
      status: "CONSUMED",
      consumedAt: new Date(),
    },
  });

  if (consumed.count === 0) {
    return {
      outcome: "used",
      message:
        "This link has already been used. If you didn't just reset your password, request a new one from the forgot-password page.",
    };
  }

  try {
    await prisma.user.update({
      where: { id: challenge.userId },
      data: {
        passwordHash,
        sessionVersion: { increment: 1 },
      },
    });
  } catch (error) {
    if (isNotFoundError(error)) {
      // The challenge row exists but the user vanished (cascade race).
      return {
        outcome: "invalid",
        message: "This password reset link is not valid.",
      };
    }

    throw error;
  }

  return {
    outcome: "reset",
    message: "Your password has been updated. You can now log in.",
  };
}

// ---------------------------------------------------------------------------
// Page helper: token inspection for the reset page's initial state
// ---------------------------------------------------------------------------

/**
 * Inspect a token for the reset page's initial render WITHOUT consuming it
 * (consumption happens only on successful password submission). The page
 * then distinguishes missing/invalid/expired/used tokens cleanly while the
 * token itself is never rendered or echoed back.
 */
export async function inspectPasswordResetToken(
  rawToken: string | null,
): Promise<
  | { state: "missing" }
  | { state: "invalid" }
  | { state: "expired" }
  | { state: "used" }
  | { state: "valid" }
> {
  if (!rawToken || !rawToken.trim()) {
    return { state: "missing" };
  }

  const tokenHash = hashPasswordResetToken(rawToken.trim());

  const challenge = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
  });

  if (!challenge) {
    return { state: "invalid" };
  }

  const classification = classifyChallenge(challenge);

  if (classification === "expired") {
    return { state: "expired" };
  }

  if (classification === "used") {
    return { state: "used" };
  }

  return classification === "valid"
    ? { state: "valid" }
    : { state: "invalid" };
}
