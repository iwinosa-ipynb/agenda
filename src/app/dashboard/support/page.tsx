import Link from "next/link";

import { Card } from "@/components/ui/card";
import { requireSupport } from "@/lib/authz";

/**
 * Stage 14D — Support dashboard overview (minimal by design).
 *
 * This is a routing destination, not an admin console: no role management,
 * no staff CRUD, no permissions UI. It confirms the caller's Support
 * authorization (requireSupport — fail-closed) and points at the one
 * operational surface that exists in 14D: milestone reviews.
 */
export default async function SupportDashboardPage() {
  await requireSupport();

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8">
      <div>
        <p className="text-sm font-medium uppercase tracking-wide text-ink-soft">
          Support
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-[-0.01em] text-ink">
          Operational review
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-soft">
          Trusted internal access for support operations. Your authorization is
          re-verified against the support roster on every request — revoked
          access ends immediately.
        </p>
      </div>

      <Card className="p-6 sm:p-8">
        <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
          <Link href="/dashboard/support/managed" className="hover:text-accent hover:underline">
            Managed briefs
          </Link>
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-ink-soft">
          Private briefs advertisers submitted to the Agenda Managed team.
          Review the full brief, advance its status: submitted → in review →
          closed, and work an internal candidate list with off-platform
          outreach tracking (log contact, record the creator&apos;s
          response). Every transition is timestamped and attributed
          server-side; candidates, outreach records and notes are visible to
          support only.
        </p>
        <p className="mt-3 text-xs leading-relaxed text-ink-faint">
          Advertisers keep full control of their own briefs — this queue never
          edits brief content, and briefs never appear in the marketplace.
        </p>
      </Card>

      <Card className="p-6 sm:p-8">
        <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
          Milestone reviews
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-ink-soft">
          Escalated milestones with the complete evidence chain: frozen terms,
          funding state, submissions, verification results and audit history.
          Decisions are explicit, attributed and immutable.
        </p>
        <p className="mt-3 text-xs leading-relaxed text-ink-faint">
          Open a review from a milestone&apos;s escalation link — one evidence
          page per escalated milestone. Financial amounts are always
          display-only on these pages.
        </p>
      </Card>
    </div>
  );
}
