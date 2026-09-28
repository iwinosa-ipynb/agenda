import type { ConnectablePlatform } from "@/lib/constants";

/**
 * Agenda Managed (V1) — sourcing-account eligibility.
 *
 * ONE definition of "this SocialAccount can back a managed-brief candidate":
 *
 *   1. the platform is one Agenda can actually run a connection for
 *      (TIKTOK / X — the same set the marketplace connection flow supports); and
 *   2. the account is OAuth-CONNECTED, i.e. it carries a provider-verified
 *      `platformUserId`.
 *
 * This deliberately mirrors — it does not redefine — the marketplace rules the
 * selected creator must satisfy later:
 *   - `applyToCampaign` requires a connected account on the campaign's
 *     platform (`platformUserId: { not: null }`, application.service.ts);
 *   - a campaign's platform is inherited from the candidate's pinned account
 *     at conversion (managed-brief-conversion.service.ts), so an account on a
 *     platform with no connection flow would produce a campaign NOBODY can
 *     ever apply to.
 *
 * A claimed-only account (`platformUserId = null`) or an account on any other
 * platform is therefore ineligible for managed sourcing — pinning one would
 * hand the selected creator a campaign they can structurally never apply to.
 *
 * Kept pure and free of "server-only"/Prisma so it is directly unit-testable
 * and safe to reuse from any layer (services, queries, read models).
 *
 * The platform is compared as a plain string on purpose: candidate rows may
 * reference legacy data, and callers select only the fields they need — a
 * full Platform enum value is never required to evaluate eligibility.
 */
export type ManagedBriefSourcingAccount = {
  platform: string;
  /** Provider-verified platform identity; null for claimed-only accounts. */
  platformUserId: string | null;
};

/** The platforms a managed-brief sourcing account must be on (TIKTOK / X). */
const ELIGIBLE_SOURCING_PLATFORMS: readonly ConnectablePlatform[] = [
  "TIKTOK",
  "X",
];

export function isManagedBriefSourcingAccountEligible(
  account: ManagedBriefSourcingAccount,
): boolean {
  return (
    (ELIGIBLE_SOURCING_PLATFORMS as readonly string[]).includes(
      account.platform,
    ) &&
    typeof account.platformUserId === "string" &&
    account.platformUserId.trim() !== ""
  );
}
