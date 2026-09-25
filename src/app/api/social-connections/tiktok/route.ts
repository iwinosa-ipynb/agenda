import { NextResponse } from "next/server";

import { generateOAuthState, generatePkceVerifier } from "@/lib/oauth-flow";
import {
  OAUTH_RETURN_PATH,
  persistOAuthTransient,
} from "@/lib/oauth-session";
import { requireVerifiedCreator } from "@/services/email-verification-guard.service";
import { buildTikTokAuthorizeUrl } from "@/services/social-connections/tiktok-oauth";

/**
 * "Connect TikTok" — start of the TikTok Login Kit authorization-code flow.
 * Same security shape as the X start route: creator-only with a verified
 * email (Stage 11), server-generated state + PKCE verifier in an httpOnly
 * cookie, no client-supplied identity, graceful degradation when
 * unconfigured.
 */

export function GET(): Promise<Response> {
  return startTikTokConnection();
}

async function startTikTokConnection(): Promise<Response> {
  await requireVerifiedCreator();

  let authorizeUrl: string;

  try {
    const state = generateOAuthState();
    const codeVerifier = generatePkceVerifier();

    const url = buildTikTokAuthorizeUrl(state, { codeVerifier });

    await persistOAuthTransient("tiktok", { state, codeVerifier });

    authorizeUrl = url;
  } catch (error) {
    console.error("connect-tiktok start failed", error);

    return NextResponse.redirect(
      new URL(
        `${OAUTH_RETURN_PATH}?connect=tiktok&error=not_configured`,
        process.env.APP_BASE_URL ?? "http://localhost:3000",
      ),
    );
  }

  return NextResponse.redirect(authorizeUrl);
}
