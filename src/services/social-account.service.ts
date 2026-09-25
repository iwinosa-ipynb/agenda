import "server-only";

import { isUniqueConstraintError } from "@/lib/prisma-errors";
import { decryptToken, encryptToken } from "@/lib/token-encryption";
import { prisma } from "@/lib/prisma";
import { revokeProviderToken } from "@/services/token-lifecycle.service";
import type { Platform, SocialAccountStatus } from "@/generated/prisma/client";
import type { ActionResult, SocialAccountSummary } from "@/types";
import type { SocialAccountInput } from "@/validation/creator";

/**
 * Social accounts are stored as claims only. Nothing here marks an account as
 * verified — that must happen through a real platform API check later. New
 * accounts always start as PENDING_VERIFICATION.
 */
export async function listSocialAccounts(
  creatorId: string,
): Promise<SocialAccountSummary[]> {
  const accounts = await prisma.socialAccount.findMany({
    where: { creatorId },
    orderBy: [{ platform: "asc" }, { createdAt: "desc" }],
    select: {
      id: true,
      platform: true,
      username: true,
      profileUrl: true,
      followerCount: true,
      status: true,
      platformUserId: true,
      createdAt: true,
    },
  });

  return accounts;
}

export async function createSocialAccount(
  creatorId: string,
  input: SocialAccountInput,
): Promise<ActionResult<{ id: string }>> {
  try {
    const account = await prisma.socialAccount.create({
      data: {
        creatorId,
        platform: input.platform,
        username: input.username,
        profileUrl: input.profileUrl,
        // Never accept status or follower count from the client.
        status: "PENDING_VERIFICATION",
        followerCount: null,
        platformUserId: null,
      },
      select: { id: true },
    });

    return { success: true, data: { id: account.id } };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return {
        success: false,
        error: "You've already added this account.",
        fieldErrors: {
          username: ["You've already added this account."],
        },
      };
    }

    console.error("createSocialAccount failed", error);
    return { success: false, error: "Could not add that account." };
  }
}

/**
 * Ownership is enforced in the query itself (`creatorId` filter), so one
 * creator can never delete another creator's account.
 */
export async function deleteSocialAccount(
  creatorId: string,
  accountId: string,
): Promise<ActionResult> {
  try {
    const result = await prisma.socialAccount.deleteMany({
      where: { id: accountId, creatorId },
    });

    if (result.count === 0) {
      return { success: false, error: "Account not found." };
    }

    return { success: true, data: undefined };
  } catch (error) {
    console.error("deleteSocialAccount failed", error);
    return { success: false, error: "Could not remove that account." };
  }
}

// ---------------------------------------------------------------------------
// Stage 8 — OAuth-connected accounts
// ---------------------------------------------------------------------------

/**
 * A connected account as exposed to the dashboard. This type is the security
 * boundary for tokens: it has NO field that could carry an access token,
 * refresh token, or any credential material — those never leave the service
 * layer below.
 */
export type ConnectedAccountSummary = {
  id: string;
  platform: Platform;
  /** Provider-verified handle from the OAuth identity response, or the manual claim. */
  username: string;
  /** Platform-side user id, when the account is connected. */
  platformUserId: string | null;
  status: SocialAccountStatus;
  connectedAt: Date | null;
  /** Scopes the user granted, verbatim, for display only. */
  grantedScopes: string | null;
  /** True when the stored access token has passed its recorded expiry. */
  tokenExpired: boolean;
  /** True when a refresh token exists, so an expired token can self-heal. */
  refreshable: boolean;
};

/** Server-side shape for a fresh OAuth grant — never serialized to clients. */
export type OAuthTokenBundle = {
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  grantedScopes: string | null;
};

/**
 * Resolve the signed-in creator's connected account for one platform, if any.
 * `creatorId` always comes from the session (requireViewerCreatorId), never
 * from a request.
 */
export async function getCreatorConnectedAccount(
  creatorId: string,
  platform: "TIKTOK" | "X",
): Promise<ConnectedAccountSummary | null> {
  const account = await prisma.socialAccount.findFirst({
    where: { creatorId, platform, connectedAt: { not: null } },
    orderBy: { connectedAt: "desc" },
  });

  if (!account) {
    return null;
  }

  return toConnectedSummary(account);
}

/** All of a creator's accounts, connected or claimed, with token info stripped. */
export async function listCreatorConnectedAccounts(
  creatorId: string,
): Promise<ConnectedAccountSummary[]> {
  const accounts = await prisma.socialAccount.findMany({
    where: { creatorId, platform: { in: ["TIKTOK", "X"] } },
    orderBy: [{ platform: "asc" }, { createdAt: "desc" }],
  });

  return accounts.map(toConnectedSummary);
}

function toConnectedSummary(
  account: {
    id: string;
    platform: Platform;
    username: string;
    platformUsername: string | null;
    platformUserId: string | null;
    status: SocialAccountStatus;
    connectedAt: Date | null;
    grantedScopes: string | null;
    accessTokenExpiresAt: Date | null;
    refreshToken: string | null;
  },
): ConnectedAccountSummary {
  return {
    id: account.id,
    platform: account.platform,
    username: account.platformUsername ?? account.username,
    platformUserId: account.platformUserId,
    status: account.status,
    connectedAt: account.connectedAt,
    grantedScopes: account.grantedScopes,
    tokenExpired: account.accessTokenExpiresAt
      ? account.accessTokenExpiresAt.getTime() <= Date.now()
      : false,
    // Presence only — the encrypted value itself never leaves this layer.
    refreshable: Boolean(account.refreshToken),
  };}

/**
 * Look up the raw connected account row for a creator + platform, decrypted
 * only on the server for verifier use. Returns null when the creator has no
 * connected account for the platform or the stored access token cannot be
 * decrypted (missing/mismatched encryption key — degraded, not fatal).
 */
export async function getCreatorPlatformCredentials(
  creatorId: string,
  platform: "TIKTOK" | "X",
): Promise<{
  platformUserId: string | null;
  accessToken: string | null;
  refreshToken: string | null;
} | null> {
  const account = await prisma.socialAccount.findFirst({
    where: { creatorId, platform, connectedAt: { not: null } },
    orderBy: { connectedAt: "desc" },
    select: {
      platformUserId: true,
      accessToken: true,
      refreshToken: true,
    },
  });

  if (!account) {
    return null;
  }

  return {
    platformUserId: account.platformUserId,
    // Decryption happens here and only here; a null token means "unusable",
    // which callers treat like an unconfigured credential (retryable path).
    accessToken: decryptToken(account.accessToken),
    refreshToken: decryptToken(account.refreshToken),
  };
}

/**
 * Persist a fresh OAuth connection for the signed-in creator.
 *
 * Security properties:
 *  - `creatorId` is resolved from the session by the caller — never accepted
 *    from the OAuth callback URL or any request field.
 *  - `identity.platformUserId` comes from the provider's identity API
 *    response fetched server-side — never from a client field.
 *  - Tokens are encrypted before storage. If no encryption key is configured
 *    the connection FAILS CLOSED (no plaintext tokens are ever persisted).
 *  - Uniqueness is enforced by the DB constraint
 *    @@unique([platform, platformUserId]): the same platform account cannot
 *    be linked to two Agenda creators. Re-connecting the SAME platform
 *    account to its existing owner is handled as an idempotent update.
 */
export async function connectPlatformAccount(
  creatorId: string,
  platform: Platform,
  identity: {
    platformUserId: string;
    platformUsername: string | null;
    displayName: string | null;
    /** Profile URL from the provider when available; a fallback is built otherwise. */
    profileUrl?: string | null;
  },
  tokens: OAuthTokenBundle | null,
): Promise<ActionResult<{ accountId: string; reconnected: boolean }>> {
  if (!identity.platformUserId) {
    return { success: false, error: "The platform did not confirm the account identity." };
  }

  // Fail closed on token persistence: if we cannot encrypt, we do not store.
  const encrypted: {
    accessToken: string | null;
    refreshToken: string | null;
  } = tokens
    ? {
        accessToken: encryptToken(tokens.accessToken),
        refreshToken: tokens.refreshToken
          ? encryptToken(tokens.refreshToken)
          : null,
      }
    : { accessToken: null, refreshToken: null };

  if (tokens && (!encrypted.accessToken || (tokens.refreshToken && !encrypted.refreshToken))) {
    console.error(
      "connectPlatformAccount: no token encryption key configured; refusing to persist tokens.",
    );
    return {
      success: false,
      error:
        "Server encryption is not configured, so the account cannot be connected securely. Contact support.",
    };
  }

  const username =
    identity.platformUsername ?? identity.displayName ?? `user-${identity.platformUserId}`;
  const profileUrl =
    identity.profileUrl ?? buildFallbackProfileUrl(platform, username);

  try {
    // Idempotent reconnect: same platform identity already connected by this
    // creator → update in place. Connected to a DIFFERENT creator → the DB
    // unique constraint rejects it and we surface a clear message.
    const existing = await prisma.socialAccount.findUnique({
      where: { platform_platformUserId: { platform, platformUserId: identity.platformUserId } },
      select: { id: true, creatorId: true },
    });

    if (existing && existing.creatorId !== creatorId) {
      return {
        success: false,
        error: "That platform account is already connected to another creator.",
      };
    }

    if (existing) {
      const updated = await prisma.socialAccount.update({
        where: { id: existing.id },
        data: {
          username,
          profileUrl,
          platformUsername: identity.platformUsername,
          status: "CONNECTED",
          connectedAt: new Date(),
          grantedScopes: tokens?.grantedScopes ?? null,
          accessToken: encrypted.accessToken,
          refreshToken: encrypted.refreshToken,
          accessTokenExpiresAt: tokens?.accessTokenExpiresAt ?? null,
          refreshTokenExpiresAt: tokens?.refreshTokenExpiresAt ?? null,
          updatedAt: new Date(),
        },
        select: { id: true },
      });

      return { success: true, data: { accountId: updated.id, reconnected: true } };
    }

    const created = await prisma.socialAccount.create({
      data: {
        creatorId,
        platform,
        username,
        profileUrl,
        platformUserId: identity.platformUserId,
        platformUsername: identity.platformUsername,
        status: "CONNECTED",
        connectedAt: new Date(),
        grantedScopes: tokens?.grantedScopes ?? null,
        accessToken: encrypted.accessToken,
        refreshToken: encrypted.refreshToken,
        accessTokenExpiresAt: tokens?.accessTokenExpiresAt ?? null,
        refreshTokenExpiresAt: tokens?.refreshTokenExpiresAt ?? null,
        // Platform identity is API-verified the moment it is connected; no
        // follower count exists yet — that comes from real API checks later.
        followerCount: null,
      },
      select: { id: true },
    });

    return { success: true, data: { accountId: created.id, reconnected: false } };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      // Raced with another creator connecting the same platform account.
      return {
        success: false,
        error: "That platform account is already connected to another creator.",
      };
    }

    console.error("connectPlatformAccount failed", error);
    return { success: false, error: "Could not save the connected account." };
  }
}

function buildFallbackProfileUrl(
  platform: Platform,
  username: string,
): string {
  switch (platform) {
    case "X":
      return `https://x.com/${encodeURIComponent(username)}`;
    case "TIKTOK":
      return `https://www.tiktok.com/@${encodeURIComponent(username)}`;
    case "INSTAGRAM":
      return `https://www.instagram.com/${encodeURIComponent(username)}/`;
    case "YOUTUBE":
      return `https://www.youtube.com/@${encodeURIComponent(username)}`;
    case "FACEBOOK":
      return `https://www.facebook.com/${encodeURIComponent(username)}`;
    default: {
      const exhaustive: never = platform;
      return `https://example.com/${encodeURIComponent(String(exhaustive))}`;
    }
  }
}

/**
 * Remove a creator's OAuth connection.
 *
 * Stage 11: first attempts a best-effort provider-side revocation of the
 * stored token (so the grant cannot keep working outside Agenda), then
 * clears every credential field locally. Revocation failure never blocks
 * the disconnect — the limitation is logged with the reason only.
 * The row itself is kept (as a claimed account) so no unrelated data
 * (posts, applications referencing the profile) is destroyed.
 */
export async function disconnectPlatformAccount(
  creatorId: string,
  platform: "TIKTOK" | "X",
): Promise<ActionResult> {
  try {
    const existing = await prisma.socialAccount.findFirst({
      where: { creatorId, platform, connectedAt: { not: null } },
      orderBy: { connectedAt: "desc" },
      select: { accessToken: true, refreshToken: true },
    });

    if (!existing) {
      return { success: false, error: "No connected account to disconnect." };
    }

    // Decrypt server-side; try whichever token exists. A failure here is
    // NOT a reason to keep usable credentials locally.
    const tokenForRevocation =
      decryptToken(existing.accessToken) ?? decryptToken(existing.refreshToken);

    if (tokenForRevocation) {
      const revoked = await revokeProviderToken(platform, tokenForRevocation);

      if (!revoked) {
        // Provider revocation unavailable (unconfigured server, provider
        // outage): the local credentials are still deleted. Documented
        // limitation — the provider-side grant remains until natural expiry.
        console.error(
          `disconnectPlatformAccount: provider revocation unavailable for ${platform}; local credentials will still be removed.`,
        );
      }
    }

    // `creatorId` in the where — one creator can never disconnect another's.
    const result = await prisma.socialAccount.updateMany({
      where: { creatorId, platform, connectedAt: { not: null } },
      data: {
        status: "PENDING_VERIFICATION",
        connectedAt: null,
        platformUserId: null,
        platformUsername: null,
        grantedScopes: null,
        accessToken: null,
        refreshToken: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
      },
    });

    if (result.count === 0) {
      return { success: false, error: "No connected account to disconnect." };
    }

    return { success: true, data: undefined };
  } catch (error) {
    console.error("disconnectPlatformAccount failed", error);
    return { success: false, error: "Could not disconnect the account." };
  }
}
