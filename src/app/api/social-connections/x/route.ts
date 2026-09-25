import { NextResponse } from "next/server";

import {
  generateOAuthState,
  generatePkceVerifier,
} from "@/lib/oauth-flow";
import {
  OAUTH_RETURN_PATH,
  persistOAuthTransient,
} from "@/lib/oauth-session";
import { requireVerifiedCreator } from "@/services/email-verification-guard.service";
import { buildXAuthorizeUrl } from "@/services/social-connections/x-oauth";

/**
 * "Connect X" — start of the OAuth 2.0 Authorization Code flow with PKCE.
 *
 * Security:
 *  - Creator-only with a verified email (Stage 11: requireVerifiedCreator
 *    resolves the session server-side, checks User.emailVerifiedAt in the
 *    database, and enforces the CREATOR role; an advertiser, anonymous
 *    visitor, or unverified creator can never start a connection).
 *  - The state + PKCE verifier are generated HERE and persisted server-side
 *    in an httpOnly cookie; only the authorize URL is sent to the browser.
 *  - No creator id, platform id, or token is accepted from anywhere in the
 *    request — this route only generates and redirects.
 *  - Unconfigured deployments get a clean redirect with an error flag, not a
 *    crash or a half-built URL.
 */

export function GET(): Promise<Response> {
  return startXConnection();
}

async function startXConnection(): Promise<Response> {
  await requireVerifiedCreator();

  let authorizeUrl: string;

  try {
    const state = generateOAuthState();
    const codeVerifier = generatePkceVerifier();

    const { url } = buildXAuthorizeUrl(state, { codeVerifier });

    await persistOAuthTransient("x", { state, codeVerifier });

    authorizeUrl = url;
  } catch (error) {
    // OAuthNotConfiguredError (and anything unexpected): report gently and
    // return the creator to their social accounts page.
    console.error("connect-x start failed", error);

    return NextResponse.redirect(
      new URL(
        `${OAUTH_RETURN_PATH}?connect=x&error=not_configured`,
        process.env.APP_BASE_URL ?? "http://localhost:3000",
      ),
    );
  }

  return NextResponse.redirect(authorizeUrl);
}
