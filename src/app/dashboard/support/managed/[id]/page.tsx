import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ManagedBriefCandidateAddForm } from "@/components/dashboard/support/managed-brief-candidate-add-form";
import { ManagedBriefCandidateRow } from "@/components/dashboard/support/managed-brief-candidate-row";
import { ManagedBriefReviewControls } from "@/components/dashboard/support/managed-brief-review-controls";
import { PageHeader } from "@/components/dashboard/page-header";
import { Badge, Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { requireSupport } from "@/lib/authz";
import { MANAGED_BRIEF_STATUS_LABELS } from "@/lib/constants";
import { formatMajor } from "@/lib/money";
import { formatDateTime } from "@/lib/utils";
import {
  getManagedBriefForSupport,
  listManagedBriefCandidateAccountOptionsForSupport,
  listManagedBriefCandidatesForSupport,
} from "@/services/managed-brief.service";
import { MANAGED_BRIEF_REVIEW_TRANSITIONS } from "@/types";

export const metadata: Metadata = {
  title: "Managed brief review",
};

/**
 * Agenda Managed (V1, slice 2) — Support review of one brief.
 *
 * Support-only: `requireSupport` (role + fresh roster re-read) redirects
 * everyone else — anonymous, CREATOR, ADVERTISER, revoked SUPPORT — to
 * /dashboard or the login page BEFORE any brief data is read, and the
 * service re-checks authorization so a foreign or guessed id fails closed.
 * The advertiser's own detail page (/dashboard/managed/[id]) keeps its
 * ownership-scoped read; these two paths never widen each other.
 */
export default async function SupportManagedBriefReviewPage({
  params,
}: PageProps<"/dashboard/support/managed/[id]">) {
  await requireSupport();

  const { id } = await params;

  const brief = await getManagedBriefForSupport(id);

  if (!brief) {
    notFound();
  }

  // Both reads re-run the Stage 14D seam internally; the page already passed
  // requireSupport, so these resolve for the same authorized operator.
  const [candidates, accountOptions] = await Promise.all([
    listManagedBriefCandidatesForSupport(brief.id),
    listManagedBriefCandidateAccountOptionsForSupport(),
  ]);

  // Single source of truth for what may happen next — the same map the
  // service's state machine enforces, so the UI can never offer a
  // transition the server would refuse.
  const [nextStatus] = MANAGED_BRIEF_REVIEW_TRANSITIONS[brief.status];
  const nextStatusLabel = nextStatus
    ? MANAGED_BRIEF_STATUS_LABELS[nextStatus]
    : null;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8">
      <Link
        href="/dashboard/support/managed"
        className="inline-flex items-center gap-1 text-sm text-ink-soft transition-colors hover:text-ink"
      >
        ← Managed briefs
      </Link>

      <PageHeader
        eyebrow="Support review"
        title={brief.campaignGoal}
        description="Private advertiser brief. Read-only except for the review status below — every transition is attributed and timestamped server-side."
        action={<Badge tone="neutral">{MANAGED_BRIEF_STATUS_LABELS[brief.status]}</Badge>}
      />

      <Card className="space-y-6 p-6 sm:p-8">
        <section className="space-y-2">
          <h2 className="text-sm font-semibold tracking-[0.14em] text-accent uppercase">
            Budget &amp; channels
          </h2>
          <p className="text-sm text-ink">
            {formatMajor(BigInt(brief.budgetMinor), brief.currency)} {brief.currency}{" "}
            <span className="text-ink-faint">(informational — nothing is charged)</span>
          </p>
          <p className="text-sm text-ink-soft">
            Channels: {brief.targetPlatforms.join(", ")}
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold tracking-[0.14em] text-accent uppercase">
            Target audience
          </h2>
          <p className="whitespace-pre-line text-sm leading-relaxed text-ink">
            {brief.targetAudience}
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold tracking-[0.14em] text-accent uppercase">
            Campaign description
          </h2>
          <p className="whitespace-pre-line text-sm leading-relaxed text-ink">
            {brief.description}
          </p>
        </section>

        {brief.creatorRequirements ? (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold tracking-[0.14em] text-accent uppercase">
              Creator requirements
            </h2>
            <p className="whitespace-pre-line text-sm leading-relaxed text-ink">
              {brief.creatorRequirements}
            </p>
          </section>
        ) : null}

        <p className="border-t border-line pt-4 text-xs text-ink-faint">
          Submitted {formatDateTime(brief.createdAt)} · Last updated{" "}
          {formatDateTime(brief.updatedAt)}
        </p>
      </Card>

      <Card className="space-y-4 p-6 sm:p-8">
        <section className="space-y-2">
          <h2 className="text-sm font-semibold tracking-[0.14em] text-accent uppercase">
            Candidate sourcing (internal)
          </h2>
          <p className="text-sm text-ink-soft">
            Potential creators for this brief, worked through the internal
            pipeline with off-platform outreach tracking (log contact → record
            the creator&apos;s response). Advertisers never see this section,
            its statuses, outreach records or notes; creators have no access
            to it at all. Nothing is sent to anyone by this workspace — it
            only records what you did off-platform.
          </p>

          {candidates.length === 0 ? (
            <div className="pt-2">
              <EmptyState
                title="No candidates yet"
                description="Add an existing creator account to start the internal sourcing pipeline for this brief."
              />
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {candidates.map((candidate) => (
                <ManagedBriefCandidateRow
                  key={candidate.id}
                  candidateId={candidate.id}
                  campaignId={candidate.campaignId}
                  status={candidate.status}
                  note={candidate.note}
                  statusUpdatedAt={candidate.statusUpdatedAt}
                  statusUpdatedById={candidate.statusUpdatedById}
                  creatorName={candidate.creator.name}
                  creatorUsername={candidate.creator.username}
                  creatorCategory={candidate.creator.category}
                  creatorFollowerCount={candidate.creator.followerCount}
                  accountPlatform={candidate.account.platform}
                  accountUsername={candidate.account.username}
                  accountProfileUrl={candidate.account.profileUrl}
                  accountStatus={candidate.account.status}
                  accountFollowerCount={candidate.account.followerCount}
                  outreach={candidate.outreach}
                />
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-2 border-t border-line pt-4">
          <h2 className="text-sm font-semibold tracking-[0.14em] text-accent uppercase">
            Add a candidate
          </h2>
          <ManagedBriefCandidateAddForm
            briefId={brief.id}
            accountOptions={accountOptions}
          />
        </section>
      </Card>

      <Card className="space-y-4 p-6 sm:p-8">
        <section className="space-y-2">
          <h2 className="text-sm font-semibold tracking-[0.14em] text-accent uppercase">
            Review status
          </h2>
          <dl className="divide-y divide-line">
            <Row
              label="Review started"
              value={
                brief.reviewStartedAt
                  ? `${formatDateTime(brief.reviewStartedAt)}${brief.reviewStartedById ? ` · by ${brief.reviewStartedById}` : ""}`
                  : "Not started"
              }
            />
            <Row
              label="Closed"
              value={
                brief.closedAt
                  ? `${formatDateTime(brief.closedAt)}${brief.closedById ? ` · by ${brief.closedById}` : ""}`
                  : "Not closed"
              }
            />
          </dl>
          <p className="text-xs text-ink-faint">
            Timestamps and operator attribution are recorded by the server on
            every transition and cannot be edited here.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold tracking-[0.14em] text-accent uppercase">
            Actions
          </h2>
          <ManagedBriefReviewControls
            briefId={brief.id}
            nextStatusLabel={nextStatusLabel}
          />
        </section>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <dt className="text-sm text-ink-soft">{label}</dt>
      <dd className="max-w-[60%] break-words text-right text-sm font-medium text-ink">{value}</dd>
    </div>
  );
}
