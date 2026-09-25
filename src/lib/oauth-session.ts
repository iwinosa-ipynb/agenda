import { cookies } from "next/headers";

/**
 * Server-side storage for OAuth flow transients (CSRF state + PKCE verifier).
 *
 * Cookie-based (not a database table) because the transients are per-browser,
 * short-lived (10 min TTL), single-use, and must never be visible to other
 * users or guessed by an attacker. Values are httpOnly + sameSite=lax +
 * secure-in-production, and are always cleared as soon as they are consumed.
 *
 * The cookie VALUE never leaves the server: the authorization URL carries the
 * state, and the callback compares the query `state` against the cookie in
 * constant time. The PKCE verifier is never sent anywhere except the token
 * exchange request.
 */

export type OAuthFlowTransient = {
  state: string;
  codeVerifier: string;
};

const COOKIE_PREFIX = "agenda_oauth_";
const TEN_MINUTES_S = 10 * 60;

function cookieName(provider: string): string {
  return `${COOKIE_PREFIX}${provider}`;
}

export async function persistOAuthTransient(
  provider: "x" | "tiktok",
  transient: OAuthFlowTransient,
): Promise<void> {
  const jar = await cookies();

  jar.set({
    name: cookieName(provider),
    value: JSON.stringify(transient),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: TEN_MINUTES_S,
  });
}

/**
 * Read and consume the transient. A missing cookie returns null; the caller
 * must treat that as an invalid callback (no silent retries — single use).
 */
export async function consumeOAuthTransient(
  provider: "x" | "tiktok",
): Promise<OAuthFlowTransient | null> {
  const jar = await cookies();
  const name = cookieName(provider);
  const raw = jar.get(name)?.value;

  if (!raw) {
    return null;
  }

  // Clear immediately: the transient is single-use whether or not the JSON
  // parses, so a replayed callback can never reuse it.
  jar.delete(name);

  try {
    const parsed = JSON.parse(raw) as Partial<OAuthFlowTransient>;

    if (!parsed || typeof parsed.state !== "string" || typeof parsed.codeVerifier !== "string") {
      return null;
    }

    return { state: parsed.state, codeVerifier: parsed.codeVerifier };
  } catch {
    return null;
  }
}

/** Redirect target back to the dashboard after a flow ends. */
export const OAUTH_RETURN_PATH = "/dashboard/social-accounts";
