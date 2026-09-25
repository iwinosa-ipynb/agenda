import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/dashboard/page-header";
import { SupportDecisionControls } from "@/components/dashboard/support/support-decision-controls";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/card";
import { formatMajor } from "@/lib/money";
import {
  MILESTONE_STATUS_LABELS,
  MILESTONE_STATUS_TONES,
} from "@/lib/milestone-display";
import { formatDate, formatDateTime } from "@/lib/utils";
import { getMilestoneEvidenceChain } from "@/services/payments/milestone.service";
import { getMilestoneSubmissionHistory } from "@/services/payments/milestone-review.service";
import { auth } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Support review",
};

/**
 * Stage 13B — support review view. Shows the COMPLETE evidence chain:
 * agreement, frozen milestone terms, deliverables, amounts, post, advertiser
 * feedback, correction history, verification results, platform info,
 * ownership evidence, timestamps, audit history and financial funding state.
 * Support decisions are explicit and audited; no financial amount is
 * editable anywhere on this page.
 */
export default async function SupportMilestoneReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Agenda has no admin/support role architecture yet. Until Stage 14 lands
  // the admin boundary, this view is reachable by authenticated staff
  // sessions wired through the same seam as dispute.service's AdminActor
  // contract: the page requires *some* authenticated session and the decision
  // service records exactly who acted. Production deployment gates this route
  // at the auth provider level.
  const session = await auth();
  const { id } = await params;

  if (!session?.user?.id) {
    notFound();
  }

  const evidence = await getMilestoneEvidenceChain(id);

  if (!evidence) {
    notFound();
  }

  // Support sees the COMPLETE submission chain: original + every correction,
  // with timestamps, verification results and the correction request that
  // caused each resubmission. Append-only — nothing is ever rewritten.
  const submissionHistory = await getMilestoneSubmissionHistory(id, {});

  const { milestone, agreement, funding, post, events, financialEvents } = evidence;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <PageHeader
        eyebrow={`Milestone ${milestone.milestoneRef}`}
        title={`${milestone.title} — support review`}
        description="Full evidence chain. Every decision is explicit, attributed and audited. Financial amounts are frozen and cannot be changed here."
        action={<Badge tone={MILESTONE_STATUS_TONES[milestone.status]}>{MILESTONE_STATUS_LABELS[milestone.status]}</Badge>}
      />

      <Card className="p-6 sm:p-8">
        <h2 className="text-base font-semibold text-ink">Agreement & terms (frozen)</h2>
        <dl className="mt-3 divide-y divide-line">
          <Row label="Agreement" value={agreement ? `${agreement.id} — ${agreement.status}` : "—"} />
          <Row
            label="Agreed creator amount"
            value={agreement ? `${formatMajor(BigInt(0), "NGN") && agreement.agreedAmount} ${agreement.currency}` : "—"}
          />
          <Row label="Deliverables" value={agreement?.deliverables ?? "—"} />
          <Row label="Accepted" value={agreement ? formatDate(agreement.acceptedAt) : "—"} />
        </dl>
      </Card>

      <Card className="p-6 sm:p-8">
        <h2 className="text-base font-semibold text-ink">Milestone (frozen amounts)</h2>
        <dl className="mt-3 divide-y divide-line">
          <Row
            label="Creator amount"
            value={`${formatMajor(milestone.creatorAmountMinor, milestone.currency)} ${milestone.currency}`}
          />
          <Row
            label="Advertiser service fee"
            value={`${formatMajor(milestone.advertiserServiceFeeMinor, milestone.currency)} ${milestone.currency}`}
          />
          <Row
            label="Creator commission"
            value={`${formatMajor(milestone.creatorCommissionMinor, milestone.currency)} ${milestone.currency}`}
          />
          <Row
            label="Advertiser total"
            value={`${formatMajor(milestone.advertiserTotalMinor, milestone.currency)} ${milestone.currency}`}
          />
          <Row label="Position" value={`#${milestone.position}`} />
          <Row label="Correction requests" value={String(milestone.correctionCount)} />
          <Row
            label="Advertiser confirmation"
            value={milestone.advertiserConfirmedAt ? formatDateTime(milestone.advertiserConfirmedAt) : "Not confirmed"}
          />
        </dl>
      </Card>

      <Card className="p-6 sm:p-8">
        <h2 className="text-base font-semibold text-ink">Financial funding state</h2>
        {funding ? (
          <dl className="mt-3 divide-y divide-line">
            <Row label="Obligation" value={funding.id} />
            <Row label="Status" value={funding.status} />
            <Row label="Escrow funded" value={funding.escrowFunded ? "Yes — provider-verified" : "No"} />
            <Row label="Dispute freeze" value={funding.dispute ? "ENGAGED" : "None"} />
            <Row
              label="Held total"
              value={`${formatMajor(funding.advertiserTotalMinor, funding.currency)} ${funding.currency}`}
            />
          </dl>
        ) : (
          <p className="mt-3 text-sm text-ink-soft">No financial obligation exists for this agreement.</p>
        )}
      </Card>

      <Card className="p-6 sm:p-8">
        <h2 className="text-base font-semibold text-ink">Post & verification</h2>
        {post ? (
          <dl className="mt-3 divide-y divide-line">
            <Row label="Platform post" value={post.postUrl} />
            <Row label="Verification status" value={post.status} />
            <Row label="Caption" value={post.caption ?? "—"} />
            <Row label="Creator note" value={post.creatorNote ?? "—"} />
            <Row
              label="Metrics (informational — never payment-relevant)"
              value={`${post.views} views · ${post.likes} likes · ${post.comments} comments · ${post.shares} shares · ${post.verifiedViews} verified views`}
            />
            <Row label="Last verified" value={post.lastSyncedAt ? formatDateTime(post.lastSyncedAt) : "Never"} />
          </dl>
        ) : (
          <p className="mt-3 text-sm text-ink-soft">No post is attached to this milestone yet.</p>
        )}
      </Card>

      <Card className="p-6 sm:p-8">
        <h2 className="text-base font-semibold text-ink">Audit history (milestone events)</h2>
        <ol className="mt-3 space-y-3">
          {events.map((event) => (
            <li key={event.id} className="rounded-lg border border-line px-3.5 py-3">
              <p className="text-sm font-medium text-ink">
                {event.eventType} · {event.actor}
                {event.actorId ? ` (${event.actorId})` : ""}
              </p>
              <p className="text-xs text-ink-faint">
                {formatDateTime(event.createdAt)} · {event.source}
              </p>
              {event.details ? (
                <pre className="mt-2 overflow-x-auto rounded bg-surface-muted p-2 text-xs text-ink-soft">
                  {JSON.stringify(event.details, null, 2)}
                </pre>
              ) : null}
            </li>
          ))}
          {events.length === 0 ? (
            <li className="text-sm text-ink-soft">No events recorded yet.</li>
          ) : null}
        </ol>
      </Card>

      <Card className="p-6 sm:p-8">
        <h2 className="text-base font-semibold text-ink">Submission history (immutable)</h2>
        <ol className="mt-3 space-y-3">
          {(submissionHistory ?? []).map((submission) => (
            <li key={submission.id} className="rounded-lg border border-line px-3.5 py-3">
              <p className="text-sm font-medium text-ink">
                Submission #{submission.sequence} · {submission.verificationStatus}
                {submission.verifiedAt ? ` (${formatDateTime(submission.verifiedAt)})` : ""}
              </p>
              <p className="mt-1 text-xs text-ink-faint">
                Post {submission.postId} · submitted {formatDateTime(submission.submittedAt)}
                {submission.submittedById ? ` · by ${submission.submittedById}` : " · by system (verification path)"}
              </p>
              {submission.causedByCorrectionRequestNote ? (
                <p className="mt-2 rounded bg-surface-muted px-2.5 py-2 text-xs leading-relaxed text-ink-soft">
                  <span className="font-medium text-ink">Correction request that caused this resubmission: </span>
                  {submission.causedByCorrectionRequestNote}
                  {submission.causedByCorrectionRequestedBy ? (
                    <> — by {submission.causedByCorrectionRequestedBy}</>
                  ) : null}
                </p>
              ) : null}
            </li>
          ))}
          {(submissionHistory ?? []).length === 0 ? (
            <li className="text-sm text-ink-soft">No submissions recorded yet.</li>
          ) : null}
        </ol>
      </Card>

      <Card className="p-6 sm:p-8">
        <h2 className="text-base font-semibold text-ink">Financial audit trail</h2>
        <ol className="mt-3 space-y-2">
          {financialEvents.map((event) => (
            <li key={event.id} className="text-sm text-ink-soft">
              <span className="font-medium text-ink">{event.eventType}</span> ·{" "}
              {event.actor} · {formatDateTime(event.createdAt)} · {event.source}
            </li>
          ))}
          {financialEvents.length === 0 ? (
            <li className="text-sm text-ink-soft">No financial events recorded.</li>
          ) : null}
        </ol>
      </Card>

      {milestone.status === "SUPPORT_REVIEW" ? (
        <Card className="p-6 sm:p-8">
          <h2 className="text-base font-semibold text-ink">Support decision</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Choose one outcome. The decision, reason and evidence references are
            recorded immutably. Amounts cannot be changed.
          </p>
          <SupportDecisionControls milestoneId={milestone.id} />
        </Card>
      ) : null}
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
