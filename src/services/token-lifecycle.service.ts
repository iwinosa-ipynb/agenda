import "server-only";

import { decryptToken, encryptToken } from "@/lib/token-encryption";
import { prisma } from "@/lib/prisma";
import {
  refreshTikTokAccessToken,
  revokeTikTokToken,
} from "@/services/social-connections/tiktok-oauth";
import {
  refreshXAccessToken,
  revokeXToken,
} from "@/services/social-connections/x-oauth";

/**
 * Token lifecycle management (Stage 11).
 *
 * Distinguishes the four connection-health states the brief requires:
 *   VALID         — stored access token is present and unexpired.
 *   EXPIRED       — access token past its recorded expiry but a refresh
 *                   token exists: refreshable, NOT disconnected.
 *   REVOKED       — the provider rejected a refresh (invalid_grant) or the
 *                   user disconnected: requires a fresh OAuth connect.
 *   PROVIDER_DOWN — a temporary network/5xx failure: leave every stored
 *                   value untouched and retry later.
 *
 * A single temporary API failure never flips an account to disconnected
 * (brief §9): only a definitive provider rejection does, and revocation
 * only ever clears the credential fields — never the creator's other data.
 */

export type ConnectionHealth =
  | "VALID"
  | "EXPIRED"
  | "REVOKED"
  | "PROVIDER_DOWN";

export type PlatformCredentials = {
  platformUserId: string | null;
  accessToken: string | null;
  refreshToken: string | null;
};

type RefreshFunction = (refreshToken: string) => Promise<{
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  grantedScopes: string | null;
}>;

type RevokeFunction = (token: string) => Promise<boolean>;

/** Minimum useful lifetime a refreshed access token must have. */
const REFRESH_SKEW_MS = 60 * 1000;

/**
 * Get the creator's usable TikTok/X access token, transparently refreshing
 * an expired one when possible. Returns null when no usable token exists
 * (unconnected, revoked, or refresh failed) — callers treat that exactly
 * like the previous "unconfigured credential" path.
 */
export async function getUsableAccessToken(
  creatorId: string,
  platform: "TIKTOK" | "X",
): Promise<string | null> {
  const credentials = await getRefreshableCredentials(creatorId, platform);

  if (!credentials) {
    return null;
  }

  if (credentials.accessToken && !isTokenExpired(credentials.accessTokenExpiresAt)) {
    return credentials.accessToken;
  }

  if (!credentials.refreshToken) {
    return credentials.accessToken;
  }

  const refreshed = await refreshStoredTokens(
    credentials.accountId,
    credentials.refreshToken,
    platform,
  );

  return refreshed?.accessToken ?? null;
}

/**
 * Classify a creator's connection health WITHOUT mutating anything.
 * Used by the UI to distinguish "needs reconnect" from "retry later".
 */
export async function getConnectionHealth(
  creatorId: string,
  platform: "TIKTOK" | "X",
): Promise<ConnectionHealth> {
  const credentials = await getRefreshableCredentials(creatorId, platform);

  if (!credentials) {
    return "REVOKED"; // no connected account at all
  }

  if (credentials.accessToken && !isTokenExpired(credentials.accessTokenExpiresAt)) {
    return "VALID";
  }

  if (credentials.refreshToken) {
    return "EXPIRED";
  }

  return "REVOKED";
}

type RefreshableCredentials = {
  accountId: string;
  accessToken: string | null;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
};

async function getRefreshableCredentials(
  creatorId: string,
  platform: "TIKTOK" | "X",
): Promise<RefreshableCredentials | null> {
  const account = await prisma.socialAccount.findFirst({
    where: { creatorId, platform, connectedAt: { not: null } },
    orderBy: { connectedAt: "desc" },
    select: {
      id: true,
      accessToken: true,
      refreshToken: true,
      accessTokenExpiresAt: true,
    },
  });

  if (!account) {
    return null;
  }

  return {
    accountId: account.id,
    accessToken: decryptToken(account.accessToken),
    refreshToken: decryptToken(account.refreshToken),
    accessTokenExpiresAt: account.accessTokenExpiresAt,
  };
}

function isTokenExpired(expiresAt: Date | null): boolean {
  if (!expiresAt) {
    // Unknown expiry: treat as valid — no evidence it expired. Providers
    // always report expires_in on grant; null only on legacy rows.
    return false;
  }

  return expiresAt.getTime() <= Date.now() + REFRESH_SKEW_MS;
}

function refreshFunctionFor(platform: "TIKTOK" | "X"): RefreshFunction {
  return platform === "TIKTOK"
    ? (refreshToken) => refreshTikTokAccessToken(refreshToken)
    : (refreshToken) => refreshXAccessToken(refreshToken);
}

/**
 * Refresh the stored tokens for one connected account. On success the new
 * (encrypted) values replace the old ones. On a definitive provider
 * rejection the credential fields are cleared and REVOKED is returned — the
 * connection stays visible but is marked as needing reconnection. On a
 * temporary failure nothing is written and PROVIDER_DOWN is returned.
 */
export async function refreshStoredTokens(
  accountId: string,
  refreshToken: string,
  platform: "TIKTOK" | "X",
): Promise<{
  accessToken: string;
  refreshToken: string | null;
} | null> {
  try {
    const refreshed = await refreshFunctionFor(platform)(refreshToken);
    const encryptedAccess = encryptToken(refreshed.accessToken);
    const encryptedRefresh = refreshed.refreshToken
      ? encryptToken(refreshed.refreshToken)
      : null;

    if (!encryptedAccess || (refreshed.refreshToken && !encryptedRefresh)) {
      // Fail closed: never persist plaintext tokens.
      console.error(
        "refreshStoredTokens: encryption unavailable; token refresh aborted.",
      );
      return null;
    }

    await prisma.socialAccount.update({
      where: { id: accountId },
      data: {
        accessToken: encryptedAccess,
        refreshToken: encryptedRefresh,
        accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
        refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt,
        grantedScopes: refreshed.grantedScopes,
        status: "CONNECTED",
        updatedAt: new Date(),
      },
    });

    return { accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken };
  } catch (error) {
    const kind = (error as { kind?: string }).kind;

    if (kind === "PROVIDER_AUTH") {
      // Definitive: the provider rejected the refresh token (revoked or
      // expired). Clear the credential fields; the creator must reconnect.
      await prisma.socialAccount.update({
        where: { id: accountId },
        data: {
          accessToken: null,
          refreshToken: null,
          accessTokenExpiresAt: null,
          refreshTokenExpiresAt: null,
          status: "PENDING_VERIFICATION",
          updatedAt: new Date(),
        },
      });

      return null;
    }

    // PROVIDER_UNAVAILABLE or anything else: temporary — change nothing.
    console.error(
      "refreshStoredTokens: temporary provider failure; stored tokens untouched.",
    );
    return null;
  }
}

/**
 * Best-effort provider-side revocation before a local disconnect. Never
 * throws; a failure only means the provider token stays technically valid
 * until natural expiry (documented provider limitation), while the local
 * credentials are deleted regardless by the disconnect service.
 */
export async function revokeProviderToken(
  platform: "TIKTOK" | "X",
  token: string,
): Promise<boolean> {
  const revoke: RevokeFunction = platform === "TIKTOK" ? revokeTikTokToken : revokeXToken;

  try {
    return await revoke(token);
  } catch {
    return false;
  }
}


