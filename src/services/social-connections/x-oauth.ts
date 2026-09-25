import "server-only";

import { derivePkceChallenge } from "@/lib/oauth-flow";
import { VerificationFailureError } from "@/services/verification";

/**
 * X (Twitter) OAuth 2.0 Authorization Code Flow with PKCE — official API only.
 *
 * Endpoints (docs.x.com):
 *   authorize:  https://x.com/i/oauth2/authorize
 *   token:      https://api.x.com/2/oauth2/token   (POST, form-encoded)
 *   identity:   https://api.x.com/2/users/me        (GET, user token)
 *
 * Confidential web-app client: the client secret stays server-side and is
 * sent via HTTP Basic auth on the token exchange, per X's documented
 * confidential-client flow. Scopes are the minimum needed to (a) read the
 * connected user's identity and (b) later look up their posts with a user
 * token if app-only auth is ever insufficient. No write scopes are requested.
 *
 * Credentials are read from the environment on every call (not module scope)
 * so tests and multi-environment deployments never see stale values, and so
 * an unconfigured deployment fails clearly (AuthorizationUrlUnavailable /
 * PROVIDER_AUTH) instead of half-working.
 */

const X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";
const X_USERS_ME_URL = "https://api.x.com/2/users/me";

/** Minimum scopes for identity + post lookup. Space-separated. */
export const X_OAUTH_SCOPES = ["users.read", "tweet.read", "offline.access"] as const;

const REQUEST_TIMEOUT_MS = 10_000;

export class OAuthNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`${provider} OAuth is not configured on this server.`);
    this.name = "OAuthNotConfiguredError";
  }
}

type XOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export function resolveXOAuthConfig(): XOAuthConfig | null {
  const clientId = process.env.X_OAUTH_CLIENT_ID;
  const clientSecret = process.env.X_OAUTH_CLIENT_SECRET;
  // The callback URL must exactly match what is registered in the provider's
  // developer console, so it comes from explicit config — with an optional
  // APP_BASE_URL fallback only when an explicit callback was not provided.
  const redirectUri =
    process.env.X_OAUTH_REDIRECT_URI ??
    (process.env.APP_BASE_URL
      ? `${process.env.APP_BASE_URL.replace(/\/+$/, "")}/api/auth/callback/x`
      : undefined);

  if (!clientId || !clientSecret || !redirectUri) {
    return null;
  }

  return { clientId, clientSecret, redirectUri };
}

/**
 * Build the authorize URL the creator is redirected to. The verifier + state
 * are generated here and must be persisted server-side (cookie) by the caller
 * before redirecting — they are the CSRF/PKCE half of the exchange.
 */
export function buildXAuthorizeUrl(
  state: string,
  options: { codeVerifier: string },
): { url: string; codeChallenge: string } {
  const config = resolveXOAuthConfig();

  if (!config) {
    throw new OAuthNotConfiguredError("X");
  }

  const codeChallenge = derivePkceChallenge(options.codeVerifier);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: X_OAUTH_SCOPES.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return { url: `${X_AUTHORIZE_URL}?${params.toString()}`, codeChallenge };
}

type XTokenResponse = {
  token_type?: string;
  expires_in?: number;
  access_token?: string;
  scope?: string;
  refresh_token?: string;
};

export type XIdentity = {
  platformUserId: string;
  platformUsername: string | null;
  displayName: string | null;
};

/**
 * Exchange the authorization code for tokens (server-side only) and fetch the
 * authenticated user's identity. Throws VerificationFailureError with kind
 * PROVIDER_AUTH on any exchange/identity failure so the route can render a
 * safe error without leaking provider detail.
 */
export async function exchangeXCodeForIdentity(
  code: string,
  codeVerifier: string,
): Promise<{ identity: XIdentity; tokens: TokenBundle }> {
  const config = resolveXOAuthConfig();

  if (!config) {
    throw new VerificationFailureError(
      "PROVIDER_AUTH",
      "X OAuth is not configured on this server.",
    );
  }

  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString(
    "base64",
  );

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    code_verifier: codeVerifier,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let tokenResponse: Response;

  try {
    tokenResponse = await fetch(X_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch {
    throw new VerificationFailureError(
      "PROVIDER_UNAVAILABLE",
      "Could not reach the X token endpoint.",
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!tokenResponse.ok) {
    throw new VerificationFailureError(
      "PROVIDER_AUTH",
      "X rejected the authorization code exchange.",
    );
  }

  const tokenPayload = (await tokenResponse.json()) as XTokenResponse;

  if (!tokenPayload.access_token) {
    throw new VerificationFailureError(
      "PROVIDER_AUTH",
      "X did not return an access token.",
    );
  }

  const identity = await fetchXIdentity(tokenPayload.access_token);

  return {
    identity,
    tokens: {
      accessToken: tokenPayload.access_token,
      refreshToken: tokenPayload.refresh_token ?? null,
      accessTokenExpiresAt: tokenPayload.expires_in
        ? new Date(Date.now() + tokenPayload.expires_in * 1000)
        : null,
      refreshTokenExpiresAt: null, // X does not report a refresh expiry.
      grantedScopes: tokenPayload.scope ?? null,
    },
  };
}

type XUsersMeResponse = {
  data?: { id?: string; username?: string; name?: string };
};

async function fetchXIdentity(accessToken: string): Promise<XIdentity> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;

  try {
    response = await fetch(
      `${X_USERS_ME_URL}?user.fields=username,name`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
        cache: "no-store",
      },
    );
  } catch {
    throw new VerificationFailureError(
      "PROVIDER_UNAVAILABLE",
      "Could not reach the X users/me endpoint.",
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new VerificationFailureError(
      "PROVIDER_AUTH",
      "X rejected the identity lookup.",
    );
  }

  const payload = (await response.json()) as XUsersMeResponse;

  if (!payload.data?.id) {
    throw new VerificationFailureError(
      "PROVIDER_AUTH",
      "X did not return the account identity.",
    );
  }

  return {
    platformUserId: payload.data.id,
    platformUsername: payload.data.username ?? null,
    displayName: payload.data.name ?? null,
  };
}

/** Shared token bundle shape (mirrors the TikTok client's). */
export type TokenBundle = {
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  grantedScopes: string | null;
};

/**
 * Refresh an X user access token with the stored refresh token (Stage 11).
 * X rotates refresh tokens on each use — the response's new refresh_token
 * must replace the stored one, or the next refresh fails.
 * Requires "offline.access" to have been granted at connect time.
 */
export async function refreshXAccessToken(
  refreshToken: string,
): Promise<TokenBundle> {
  const config = resolveXOAuthConfig();

  if (!config) {
    throw new VerificationFailureError(
      "PROVIDER_AUTH",
      "X OAuth is not configured on this server.",
    );
  }

  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;

  try {
    response = await fetch(X_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch {
    throw new VerificationFailureError(
      "PROVIDER_UNAVAILABLE",
      "Could not reach the X token endpoint.",
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    // 400/401 with invalid_grant typically means the refresh token was
    // revoked or expired — the creator must reconnect.
    throw new VerificationFailureError(
      "PROVIDER_AUTH",
      "X rejected the token refresh.",
    );
  }

  const payload = (await response.json()) as XTokenResponse;

  if (!payload.access_token) {
    throw new VerificationFailureError(
      "PROVIDER_AUTH",
      "X did not return an access token.",
    );
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? refreshToken,
    accessTokenExpiresAt: payload.expires_in
      ? new Date(Date.now() + payload.expires_in * 1000)
      : null,
    refreshTokenExpiresAt: null,
    grantedScopes: payload.scope ?? null,
  };
}

/**
 * Revoke an X user token (Stage 11 disconnect). Best-effort: failures are
 * never thrown to the caller — the local disconnect proceeds regardless and
 * the limitation is surfaced by the return value.
 * https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/token-revocation (RFC 7009)
 */
export async function revokeXToken(token: string): Promise<boolean> {
  const config = resolveXOAuthConfig();

  if (!config) {
    return false;
  }

  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");

  try {
    const response = await fetch("https://api.x.com/2/oauth2/revoke", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token }).toString(),
      cache: "no-store",
    });

    return response.ok;
  } catch {
    return false;
  }
}
