import "server-only";

import { prisma } from "@/lib/prisma";
import {
  evaluateResendRateLimit,
  generateVerificationToken,
  hashVerificationToken,
  verificationExpiry,
} from "@/lib/verification-token";
import {
  EmailDeliveryError,
  EmailNotConfiguredError,
  sendEmail,
} from "@/lib/email/email-service";
import { buildVerificationUrl, renderVerificationEmail } from "@/lib/email/verification-email";
import { isUniqueConstraintError } from "@/lib/prisma-errors";

/**
 * Enumeration-safe email-verification entry points (Stage 10).
 *
 * These functions answer requests that carry an email address from a
 * logged-out page. Whether or not the address belongs to an account, the
 * response is identical — the only side effect (an email) happens when the
 * address is real. This mirrors OWASP guidance for password-reset flows.
 */

/** Generic message returned regardless of account existence. */
export const GENERIC_PENDING_MESSAGE =
  "If that email belongs to an Agenda account, a verification link is on its way.";

const RESEND_WINDOW_MS = 24 * 60 * 60 * 1000;

export type SafeResendOutcome = {
  /** Always the same generic message, whether or not the account exists. */
  message: string;
  retryAfterSeconds?: number;
};

/**
 * Request a fresh verification email for an arbitrary email address
 * (enumeration-safe). Used by the logged-out "resend verification" form.
 */
export async function requestVerificationEmailForAddress(
  rawEmail: string,
): Promise<SafeResendOutcome> {
  const email = rawEmail.trim().toLowerCase();
  const generic = { message: GENERIC_PENDING_MESSAGE };

  if (!email) {
    return generic;
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, emailVerifiedAt: true },
  });

  if (!user) {
    // Unknown address: do exactly nothing and return the same message.
    return generic;
  }

  if (user.emailVerifiedAt) {
    // Already verified: also no email, same generic response.
    return generic;
  }

  const windowStart = new Date(Date.now() - RESEND_WINDOW_MS);

  const [newest, recentCount] = await Promise.all([
    prisma.emailVerificationToken.findFirst({
      where: { userId: user.id, createdAt: { gte: windowStart } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.emailVerificationToken.count({
      where: {
        userId: user.id,
        createdAt: { gte: windowStart },
        status: { in: ["PENDING", "CONSUMED", "SUPERSEDED"] },
      },
    }),
  ]);

  const decision = evaluateResendRateLimit(
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

  const issued = await issueChallengeAndSend({ userId: user.id, email });

  if (!issued.ok && issued.reason === "email_not_configured") {
    // Distinguish operator-visible failure without leaking account
    // existence: the message stays generic, the console gets the reason.
    console.error(
      "email-verification: resend for address skipped —",
      "email not configured",
    );
  }

  return generic;
}

/**
 * Create a challenge and send the email for a known-existing, unverified
 * user. Shared by the logged-out address flow; the authenticated resend for
 * the signed-in user lives in email-verification.service.ts.
 */
async function issueChallengeAndSend(input: {
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
