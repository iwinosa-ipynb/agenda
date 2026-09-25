import { z } from "zod";

/**
 * Validation for OAuth callback inputs (X + TikTok connection flows).
 *
 * Deliberately NOT defined here: any schema that would encourage the client
 * to submit creatorIds, platformUserIds, usernames-as-identity or tokens.
 * The callback URL carries only what the provider is specified to send
 * (code / state / error) — every identity value is fetched server-side from
 * the provider's own API response, and the Agenda creator comes from the
 * session.
 */

/**
 * A provider authorization code. Bounded length; no format assumptions
 * beyond "opaque non-empty token" — providers may change their formats.
 */
export const oauthCodeSchema = z
  .string()
  .trim()
  .min(1, { message: "Missing authorization code." })
  .max(512, { message: "Authorization code is invalid." });

/**
 * The state echoed back by the provider. Must look like
 * `<token>.<issuedAtMs>`: bounded length and no control characters, so it can
 * never smuggle header/newline content. Actual match validation happens
 * constant-time against the cookie value in the route handler.
 */
export const oauthStateSchema = z
  .string()
  .trim()
  .min(3, { message: "Missing OAuth state." })
  .max(600, { message: "OAuth state is invalid." })
  .regex(/^[\w-]+\.\d{1,15}$/, {
    message: "OAuth state is malformed.",
  });

/**
 * Standard OAuth error response parameters (RFC 6749 §4.1.2.1): the provider
 * redirects back with `error` (and optionally `error_description`) when the
 * user denies authorization. Parsing this is enough to detect "denied" —
 * the error text is provider-controlled and never shown verbatim to users.
 */
export const oauthErrorSchema = z.object({
  error: z
    .string()
    .trim()
    .min(1)
    .max(100),
  error_description: z
    .string()
    .trim()
    .max(500)
    .optional(),
});

export type OAuthCallbackQuery = {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
};

/**
 * Normalize raw URL search params (both X and TikTok callbacks) into a typed
 * object, collapsing the three callback shapes into one discriminated result:
 * denied (provider error), ok (code + state), or invalid (missing pieces).
 */
export function parseOAuthCallbackParams(
  params: URLSearchParams,
):
  | { kind: "DENIED"; error: string }
  | { kind: "OK"; code: string; state: string }
  | { kind: "INVALID" } {
  const error = params.get("error");

  if (error !== null) {
    const parsed = oauthErrorSchema.safeParse({
      error,
      error_description: params.get("error_description") ?? undefined,
    });

    return parsed.success
      ? { kind: "DENIED", error: parsed.data.error }
      : { kind: "INVALID" };
  }

  const code = params.get("code");
  const state = params.get("state");

  const parsed = z
    .object({ code: oauthCodeSchema, state: oauthStateSchema })
    .safeParse({ code, state });

  if (!parsed.success) {
    return { kind: "INVALID" };
  }

  return { kind: "OK", code: parsed.data.code, state: parsed.data.state };
}
