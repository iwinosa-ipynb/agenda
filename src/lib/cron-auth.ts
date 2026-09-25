import { timingSafeEqual } from "node:crypto";

/**
 * Pure authorization check for machine-to-machine scheduled endpoints
 * (cron / external schedulers). The scheduler authenticates with a shared
 * secret via the standard `Authorization: Bearer <secret>` header.
 *
 * Fails closed: when no secret is configured on the server, every external
 * trigger is refused — an unconfigured endpoint must never run verification.
 *
 * Kept dependency-light and side-effect-free so it can be unit tested.
 */
export function isAuthorizedCronRequest(
  authorizationHeader: string | null,
  expectedSecret: string | undefined,
): boolean {
  if (!expectedSecret) {
    return false;
  }

  if (!authorizationHeader) {
    return false;
  }

  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());

  if (!match) {
    return false;
  }

  const provided = Buffer.from(match[1]);
  const expected = Buffer.from(expectedSecret);

  if (provided.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(provided, expected);
}
