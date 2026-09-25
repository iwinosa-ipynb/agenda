import { NextResponse } from "next/server";

import { requireRole } from "@/lib/authz";
import {
  OAUTH_RETURN_PATH,
  consumeOAuthTransient,
} from "@/lib/oauth-session";
import { validateOAuthState } from "@/lib/oauth-flow";
import { requireViewerCreatorId } from "@/services/creator.service";
import { connectPlatformAccount } from "@/services/social-account.service";
import { exchangeTikTokCodeForIdentity } from "@/services/social-connections/tiktok-oauth";
import { parseOAuthCallbackParams } from "@/validation/oauth";

/**
 * TikTok OAuth callback — mirrors the X callback's security model:
 * session-resolved creator, single-use state cookie validated constant-time,
 * server-side code exchange with PKCE, identity from TikTok's own API
 * (open_id from the token response + user info enrichment), tokens encrypted
 * before persistence, duplicate platform accounts refused.
 */

export async function GET(request: Request): Promise<Response> {
  await requireRole("CREATOR");

  const url = new URL(request.url);
  const params = parseOAuthCallbackParams(url.searchParams);

  const fail = (reason: string) =>
    NextResponse.redirect(
      new URL(`${OAUTH_RETURN_PATH}?connect=tiktok&error=${reason}`, url.origin),
    );

  if (params.kind === "DENIED") {
    return fail("denied");
  }

  if (params.kind === "INVALID") {
    return fail("invalid_response");
  }

  const transient = await consumeOAuthTransient("tiktok");

  if (!transient) {
    return fail("expired");
  }

  if (!validateOAuthState(params.state, transient.state)) {
    return fail("state_mismatch");
  }

  const creatorId = await requireViewerCreatorId();

  try {
    const { identity, tokens } = await exchangeTikTokCodeForIdentity(
      params.code,
      transient.codeVerifier,
    );

    const result = await connectPlatformAccount(creatorId, "TIKTOK", identity, tokens);

    if (!result.success) {
      console.error("tiktok connect failed", result.error);
      return fail(
        result.error === "That platform account is already connected to another creator."
          ? "account_taken"
          : result.error.startsWith("Server encryption")
            ? "encryption_unconfigured"
            : "persist_failed",
      );
    }

    return NextResponse.redirect(
      new URL(`${OAUTH_RETURN_PATH}?connect=tiktok&status=connected`, url.origin),
    );
  } catch (error) {
    console.error("tiktok oauth exchange failed", error);
    return fail("exchange_failed");
  }
}
