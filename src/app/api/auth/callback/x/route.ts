import { NextResponse } from "next/server";

import { requireRole } from "@/lib/authz";
import {
  OAUTH_RETURN_PATH,
  consumeOAuthTransient,
} from "@/lib/oauth-session";
import { validateOAuthState } from "@/lib/oauth-flow";
import { requireViewerCreatorId } from "@/services/creator.service";
import { connectPlatformAccount } from "@/services/social-account.service";
import { exchangeXCodeForIdentity } from "@/services/social-connections/x-oauth";
import { parseOAuthCallbackParams } from "@/validation/oauth";

/**
 * X OAuth callback — the provider redirects here after the creator approves
 * (or denies) access. Everything security-relevant happens server-side:
 *
 *  - The Agenda creator is resolved from the SESSION, never from the query
 *    string (a callback URL can be edited by anyone; the session cookie is
 *    signed by us). This is what prevents cross-user account linking.
 *  - The `state` is validated constant-time against the single-use httpOnly
 *    cookie set by the start route; missing/expired/foreign states fail.
 *  - The authorization code is exchanged server-side with the client secret
 *    (Basic auth) + PKCE verifier. Tokens never touch the client.
 *  - Identity comes from X's /2/users/me response — platformUserId is never
 *    read from a request field.
 *  - Duplicate/foreign platform accounts are refused by the service's DB
 *    uniqueness handling.
 *
 * All outcomes redirect back to /dashboard/social-accounts with a status
 * flag; no provider error text is forwarded verbatim.
 */

export async function GET(request: Request): Promise<Response> {
  await requireRole("CREATOR");

  const url = new URL(request.url);
  const params = parseOAuthCallbackParams(url.searchParams);

  const fail = (reason: string) =>
    NextResponse.redirect(
      new URL(`${OAUTH_RETURN_PATH}?connect=x&error=${reason}`, url.origin),
    );

  if (params.kind === "DENIED") {
    return fail("denied");
  }

  if (params.kind === "INVALID") {
    return fail("invalid_response");
  }

  const transient = await consumeOAuthTransient("x");

  if (!transient) {
    // Expired, already consumed, or forged callback with no flow started.
    return fail("expired");
  }

  if (!validateOAuthState(params.state, transient.state)) {
    return fail("state_mismatch");
  }

  const creatorId = await requireViewerCreatorId();

  try {
    const { identity, tokens } = await exchangeXCodeForIdentity(
      params.code,
      transient.codeVerifier,
    );

    const result = await connectPlatformAccount(creatorId, "X", identity, tokens);

    if (!result.success) {
      console.error("x connect failed", result.error);
      return fail(
        result.error === "That platform account is already connected to another creator."
          ? "account_taken"
          : result.error.startsWith("Server encryption")
            ? "encryption_unconfigured"
            : "persist_failed",
      );
    }

    return NextResponse.redirect(
      new URL(`${OAUTH_RETURN_PATH}?connect=x&status=connected`, url.origin),
    );
  } catch (error) {
    console.error("x oauth exchange failed", error);
    return fail("exchange_failed");
  }
}
