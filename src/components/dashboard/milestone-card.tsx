import type { MilestoneView } from "@/services/payments/milestone.service";
import { formatMajor } from "@/lib/money";
import {
  MILESTONE_STATUS_LABELS,
  MILESTONE_STATUS_TONES,
  reviewWindowLine,
  creatorCorrectionLine,
} from "@/lib/milestone-display";
import { Badge } from "@/components/ui/card";
import { Card } from "@/components/ui/card";
import { AdvertiserMilestoneControls } from "@/components/dashboard/advertiser/milestone-controls";
import { CreatorMilestoneCorrectionControls } from "@/components/dashboard/creator/milestone-correction-controls";
import { MilestoneSubmitPostForm } from "@/components/dashboard/creator/milestone-submit-post-form";
import { PLATFORM_LABELS } from "@/lib/constants";
import { formatDate } from "@/lib/utils";

/**
 * Stage 13B — shared milestone read card. Server-rendered from the frozen
 * milestone row; the review timer is derived ONLY from server timestamps.
 * There is no "auto release" copy anywhere because no automatic release
 * exists. Low views/likes/comments are never displayed as payment-relevant —
 * metrics are informational only.
 */
export function MilestoneCard({
  milestone,
  viewer,
}: {
  milestone: MilestoneView;
  viewer: "ADVERTISER" | "CREATOR";
}) {
  const tone = MILESTONE_STATUS_TONES[milestone.status];
  const windowLine = reviewWindowLine(milestone.status, milestone.reviewWindowDeadlineAt);
  const correctionLine = creatorCorrectionLine(milestone.status);

  const showAdvertiserControls =
    viewer === "ADVERTISER" && milestone.status === "VERIFIED_PENDING_REVIEW";

  const showCreatorCorrectionControls =
    viewer === "CREATOR" && milestone.status === "CORRECTION_REQUESTED" && milestone.paidPostId !== null;

  // Stage 13C: the creator submits against THIS milestone (PENDING only;
  // correction states use the correction controls instead).
  const showCreatorSubmitForm = viewer === "CREATOR" && milestone.status === "PENDING";

  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <p className="text-xs text-ink-faint">
            Milestone {milestone.position} · {milestone.milestoneRef}
          </p>
          <h3 className="text-base font-semibold tracking-[-0.01em] text-ink">
            {milestone.title}
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={tone}>{MILESTONE_STATUS_LABELS[milestone.status]}</Badge>
          </div>
        </div>

        {milestone.paidPost ? (
          <a
            href={milestone.paidPost.postUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-sm text-accent underline-offset-2 hover:underline"
          >
            View post ({PLATFORM_LABELS[milestone.paidPost.platform]})
          </a>
        ) : null}
      </div>

      {milestone.deliverables ? (
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          <span className="font-medium text-ink">Deliverables: </span>
          {milestone.deliverables}
        </p>
      ) : null}

      {/* Frozen amounts — server-derived at plan time, never client values. */}
      <dl className="mt-4 grid gap-4 border-t border-line pt-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-xs text-ink-faint">Creator amount</dt>
          <dd className="mt-0.5 text-sm font-semibold text-ink">
            {formatMajor(milestone.creatorAmountMinor, milestone.currency)} {milestone.currency}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-faint">Advertiser service fee (5%)</dt>
          <dd className="mt-0.5 text-sm text-ink">
            {formatMajor(milestone.advertiserServiceFeeMinor, milestone.currency)} {milestone.currency}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-faint">Creator commission (10%)</dt>
          <dd className="mt-0.5 text-sm text-ink">
            {formatMajor(milestone.creatorCommissionMinor, milestone.currency)} {milestone.currency}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-faint">Advertiser total</dt>
          <dd className="mt-0.5 text-sm font-semibold text-ink">
            {formatMajor(milestone.advertiserTotalMinor, milestone.currency)} {milestone.currency}
          </dd>
        </div>
      </dl>

      {milestone.status === "VERIFIED_PENDING_REVIEW" ? (
        <p className="mt-4 rounded-lg border border-dashed border-line-strong bg-surface-muted px-3.5 py-3 text-xs leading-relaxed text-ink-soft">
          Your creator&apos;s work has been verified. Please review the completed
          work against your agreement. {windowLine}
        </p>
      ) : null}

      {milestone.status === "CORRECTION_REQUESTED" && viewer === "CREATOR" ? (
        <div className="mt-4 rounded-lg border border-dashed border-warning-strong/30 bg-warning-soft px-3.5 py-3">
          <p className="text-xs font-medium text-ink">Correction Requested</p>
          <p className="mt-1 text-sm leading-relaxed text-ink-soft">
            {milestone.correctionRequestNote ?? "The advertiser requested a correction."}
          </p>
        </div>
        ) : null}

      {milestone.status === "CORRECTION_REQUESTED" && viewer === "ADVERTISER" ? (
        <p className="mt-4 rounded-lg border border-dashed border-line-strong bg-surface-muted px-3.5 py-3 text-xs leading-relaxed text-ink-soft">
          Correction Requested — Waiting for Creator. The review window is
          paused while the creator works.
        </p>
      ) : null}

      {milestone.status === "PENDING_REVERIFICATION" ? (
        <p className="mt-4 rounded-lg border border-dashed border-line-strong bg-surface-muted px-3.5 py-3 text-xs leading-relaxed text-ink-soft">
          Correction Submitted — Awaiting Verification. Verification will re-run
          against the corrected post, then a fresh 24-hour review window opens.
        </p>
      ) : null}

      {milestone.status === "SUPPORT_REVIEW" ? (
        <p className="mt-4 rounded-lg border border-dashed border-line-strong bg-surface-muted px-3.5 py-3 text-xs leading-relaxed text-ink-soft">
          {correctionLine ?? "Escalated to Agenda support. Funds remain protected while support reviews the evidence."}
        </p>
      ) : null}

      {milestone.status === "PENDING" ? (
        <p className="mt-4 rounded-lg border border-dashed border-line-strong bg-surface-muted px-3.5 py-3 text-xs leading-relaxed text-ink-soft">
          {viewer === "CREATOR"
            ? milestone.requiredPostCount > 1
              ? `This milestone requires ${milestone.requiredPostCount} verified posts. Submit each published post here — advertiser review opens only when all of them verify.`
              : "Publish your deliverable, then submit the post link against this milestone. Payment is based on fulfilling the agreed deliverables — never on views, likes or comments."
            : "Waiting for the creator's submission. The review window opens only after platform verification passes for every required post."}
        </p>
      ) : null}

      {milestone.status === "RELEASED" && milestone.releasedAt ? (
        <p className="mt-4 text-xs text-ink-faint">
          Released {formatDate(milestone.releasedAt)}. Fees for this milestone
          are earned.
        </p>
      ) : null}

      {milestone.correctionCount > 0 && milestone.correctionRequestedAt ? (
        <p className="mt-4 text-xs text-ink-faint">
          {milestone.correctionCount} correction
          {milestone.correctionCount === 1 ? "" : "s"} requested · last on{" "}
          {formatDate(milestone.correctionRequestedAt)}
        </p>
      ) : null}

      {showCreatorSubmitForm ? (
        <MilestoneSubmitPostForm
          milestoneId={milestone.id}
          platform={milestone.agreement.platform}
        />
      ) : null}

      {showAdvertiserControls ? (
        <AdvertiserMilestoneControls milestoneId={milestone.id} />
      ) : null}

      {showCreatorCorrectionControls ? (
        <CreatorMilestoneCorrectionControls
          milestoneId={milestone.id}
          postId={milestone.paidPostId as string}
        />
      ) : null}
    </Card>
  );
}
