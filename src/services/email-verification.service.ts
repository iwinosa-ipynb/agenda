import "server-only";

import {
  EmailDeliveryError,
  EmailNotConfiguredError,
  sendEmail,
} from "@/lib/email/email-service";
import { buildVerificationUrl, renderVerificationEmail } from "@/lib/email/verification-email";
import { isNotFoundError, isUniqueConstraintError } from "@/lib/prisma-errors";
import { prisma } from "@/lib/prisma";
import { GENERIC_PENDING_MESSAGE } from "@/services/email-verification-account.service";
import {
  RESEND_MAX_PER_DAY,
  evaluateResendRateLimit,
  generateVerificationToken,
  hashVerificationToken,
  verificationExpiry,
} from "@/lib/verification-token";

/**
 * Email-verification service (Stage 10).
 *
 * Rules:
 *  - At most ONE PENDING challenge per user (DB-enforced via the
 *    (userId, status) unique index). A resend supersedes the previous one.
 *  - Only the SHA-256 hash of a token is stored; the raw token is returned
 *    exactly once by `issueVerification` so the caller can email it, and is
 *    never logged, never stored, never sent to the client.
 *  - Consumption is a single conditional UPDATE (`consumedAt: null` in the
 *    WHERE) — the database is the concurrency arbiter, so two parallel
 *    clicks cannot both verify. Expiry is absolute, independent of status.
 *  - Enumeration-safe: every function that answers a client-facing request
 *    returns a generic, safe result whether or not the account exists.
 */

/**
 * Map a token to its row. Expiry is checked against the absolute timestamp,
 * NOT just the status column, so an un-expired-status row can never be used
 * after its deadline even if the cleanup job has not run yet.
 */
async function findConsumableChallenge(token: string) {
  const tokenHash = hashVerificationToken(token);

  const challenge = await prisma.emailVerificationToken.findUnique({
    where: { tokenHash },
  });

  if (!challenge) {
    return null;
  }

  return challenge;
}

function classifyChallenge(challenge: {
  status: string;
  expiresAt: Date;
}): "invalid" | "expired" | "used" | "valid" {
  const now = new Date();

  if (challenge.expiresAt.getTime() <= now.getTime()) {
    return "expired";
  }

  if (challenge.status === "CONSUMED") {
    return "used";
  }

  return challenge.status === "PENDING" ? "valid" : "invalid";
}

export type VerificationOutcome =
  | "verified" // token valid and consumed in this call
  | "already_verified" // the linked user's email was already verified
  | "expired" // token past its absolute expiry
  | "used" // token already consumed (replay attempt)
  | "invalid"; // unknown token

/** Public-safe description of a verification attempt — never echoes tokens. */
export type VerifyEmailResult =
  | { outcome: "verified"; message: string }
  | { outcome: "already_verified"; message: string }
  | { outcome: "expired"; message: string }
  | { outcome: "used"; message: string }
  | { outcome: "invalid"; message: string };

/**
 * Consume a verification token. This is the only path that sets
 * User.emailVerifiedAt, and it is entirely server-side.
 */
export async function verifyEmailWithToken(
  rawToken: string,
): Promise<VerifyEmailResult> {
  const trimmed = rawToken.trim();

  if (!trimmed) {
    return {
      outcome: "invalid",
      message: "This verification link is not valid.",
    };
  }

  const challenge = await findConsumableChallenge(trimmed);

  if (!challenge) {
    return {
      outcome: "invalid",
      message: "This verification link is not valid.",
    };
  }

  const classification = classifyChallenge(challenge);

  if (classification === "expired") {
    return {
      outcome: "expired",
      message: "This verification link has expired. Request a new one.",
    };
  }

  if (classification === "used") {
    return {
      outcome: "used",
      message: "This link has already been used. Your email may already be verified — log in and check your dashboard.",
    };
  }

  if (classification !== "valid") {
    return {
      outcome: "invalid",
      message: "This verification link is not valid.",
    };
  }

  // Single-use enforcement: the WHERE clause requires the row to still be
  // unconsumed and unexpired. If another request consumed it first, update
  // matches zero rows and we report the challenge as used.
  const consumed = await prisma.emailVerificationToken.updateMany({
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
        "This link has already been used. Your email may already be verified — log in and check your dashboard.",
    };
  }

  try {
    await prisma.user.update({
      where: { id: challenge.userId },
      data: { emailVerifiedAt: new Date() },
    });
  } catch (error) {
    if (isNotFoundError(error)) {
      // The challenge row exists but the user vanished (cascade race).
      return {
        outcome: "invalid",
        message: "This verification link is not valid.",
      };
    }

    throw error;
  }

  return {
    outcome: "verified",
    message: "Your email address is now verified.",
  };
}

/**
 * Create a fresh challenge and send the verification email.
 *
 * Returns the raw token ONLY to the caller (who must only email it) — this
 * exists so tests and future providers can capture it without re-reading the
 * DB. It is not persisted in plaintext and never logged here.
 */
async function issueVerification(input: {
  userId: string;
  email: string;
}): Promise<
  | { ok: true; rawToken: string }
  | { ok: false; reason: "email_not_configured" | "delivery_failed" }
> {
  const rawToken = generateVerificationToken();
  const tokenHash = hashVerificationToken(rawToken);
  const issuedAt = new Date();

  try {
    // Supersede any outstanding challenge first so the (userId, status)
    // unique index never rejects the new PENDING row.
    await prisma.$transaction([
      prisma.emailVerificationToken.updateMany({
        where: { userId: input.userId, status: "PENDING" },
        data: { status: "SUPERSEDED", supersededAt: issuedAt },
      }),
      prisma.emailVerificationToken.create({
        data: {
          userId: input.userId,
          tokenHash,
          status: "PENDING",
          expiresAt: verificationExpiry(issuedAt),
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

  const url = buildVerificationUrl(rawToken);
  const email = renderVerificationEmail({
    recipientEmail: input.email,
    verificationUrl: url,
  });

  try {
    await sendEmail(email);
  } catch (error) {
    // The challenge stays PENDING so a retry/resend can use it once email
    // is configured; the token itself is never exposed to the client.
    if (error instanceof EmailNotConfiguredError) {
      console.error(
        "email-verification: send skipped —",
        (error as Error).message,
      );
      return { ok: false, reason: "email_not_configured" };
    }

    if (error instanceof EmailDeliveryError) {
      console.error(
        "email-verification: send failed with provider status",
        (error as EmailDeliveryError).status,
      );
      return { ok: false, reason: "delivery_failed" };
    }

    throw error;
  }

  return { ok: true, rawToken };
}

export type IssueForUserResult =
  | { success: true }
  | { success: false; error: string };

/**
 * Registration hook: create the account's first verification challenge and
 * send the email. Never throws for provider problems — the account exists
 * either way, and the user can resend later.
 */
export async function issueVerificationForNewUser(input: {
  userId: string;
  email: string;
}): Promise<IssueForUserResult> {
  const result = await issueVerification(input);

  if (!result.ok) {
    if (result.reason === "email_not_configured") {
      return {
        success: false,
        error:
          "Account created, but the email service is not configured on this server yet. Use the resend option after setup.",
      };
    }

    return {
      success: false,
      error:
        "Account created, but we couldn't send the verification email right now. You can resend it from your dashboard.",
    };
  }

  return { success: true };
}

export type ResendRateWindowDays = 1;

/**
 * Resend a verification email for the signed-in user (rate-limited).
 *
 * Because the caller is authenticated, this can be specific (no need for
 * enumeration-safe vagueness): the caller sees real success/failure.
 * Never returns the token or any challenge material.
 */
export async function resendVerificationEmailForUser(input: {
  userId: string;
  email: string;
}): Promise<IssueForUserResult & { retryAfterSeconds?: number }> {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, emailVerifiedAt: true },
  });

  if (!user) {
    return { success: false, error: "Could not process the request." };
  }

  if (user.emailVerifiedAt) {
    return { success: true };
  }

  const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [lastPending, recentCount] = await Promise.all([
    prisma.emailVerificationToken.findFirst({
      where: { userId: input.userId, status: "PENDING" },
      orderBy: { createdAt: "desc" },
    }),
    prisma.emailVerificationToken.count({
      where: {
        userId: input.userId,
        createdAt: { gte: windowStart },
        status: { in: ["PENDING", "CONSUMED", "SUPERSEDED"] },
      },
    }),
  ]);

  // Rate-limit anchor: the newest challenge of ANY status in the window. The
  // pure decision logic lives in verification-token.ts (unit tested there).
  const newest = await prisma.emailVerificationToken.findFirst({
    where: {
      userId: input.userId,
      createdAt: { gte: windowStart },
    },
    orderBy: { createdAt: "desc" },
  });

  const decision = evaluateResendRateLimit(
    new Date(),
    newest?.createdAt ?? null,
    recentCount,
  );

  if (!decision.allowed) {
    const retryAfterSeconds =
      decision.reason === "min_interval" && newest
        ? Math.max(
            1,
            Math.ceil(
              (newest.createdAt.getTime() +
                60 * 1000 -
                Date.now()) /
                1000,
            ),
          )
        : 24 * 60 * 60;

    return {
      success: false,
      error:
        decision.reason === "min_interval"
          ? "Please wait a minute before requesting another email."
          : "You've requested the maximum number of emails for today. Try again tomorrow.",
      retryAfterSeconds,
    };
  }

  // `lastPending` was fetched for the supersede inside issueVerification; it
  // is intentionally not acted on here — the transaction there supersedes
  // ALL outstanding challenges atomically.
  void lastPending;

  const issued = await issueVerification(input);

  if (!issued.ok) {
    if (issued.reason === "email_not_configured") {
      return {
        success: false,
        error:
          "The email service is not configured on this server yet. Ask the operator to set EMAIL_PROVIDER, BREVO_API_KEY and EMAIL_FROM_ADDRESS.",
      };
    }

    return {
      success: false,
      error: "We couldn't send the email right now. Please try again shortly.",
    };
  }

  return { success: true };
}

/**
 * Delete fully-resolved challenges older than the cutoff (cleanup job).
 * Returns the number of rows removed. Never touches PENDING challenges.
 */
export async function cleanupResolvedVerificationChallenges(input: {
  olderThan: Date;
}): Promise<number> {
  const result = await prisma.emailVerificationToken.deleteMany({
    where: {
      status: { in: ["CONSUMED", "SUPERSEDED", "EXPIRED"] },
      updatedAt: { lt: input.olderThan },
    },
  });

  return result.count;
}

export { GENERIC_PENDING_MESSAGE };
export { RESEND_MAX_PER_DAY };
