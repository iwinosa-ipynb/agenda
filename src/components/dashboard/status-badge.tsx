import { Badge, type BadgeTone } from "@/components/ui/card";
import {
  APPLICATION_STATUS_LABELS,
  CAMPAIGN_STATUS_LABELS,
  POST_STATUS_LABELS,
  SOCIAL_ACCOUNT_STATUS_LABELS,
} from "@/lib/constants";
import { INTEGRITY_LABELS } from "@/lib/verified-view-display";
import type {
  ApplicationStatus,
  CampaignStatus,
  PostStatus,
  SocialAccountStatus,
} from "@/types";

const APPLICATION_TONES: Record<ApplicationStatus, BadgeTone> = {
  PENDING: "warning",
  ACCEPTED: "accent",
  REJECTED: "danger",
  WITHDRAWN: "muted",
};

const SOCIAL_ACCOUNT_TONES: Record<SocialAccountStatus, BadgeTone> = {
  PENDING_VERIFICATION: "warning",
  VERIFIED: "accent",
  CONNECTED: "neutral",
};

const CAMPAIGN_TONES: Record<CampaignStatus, BadgeTone> = {
  DRAFT: "muted",
  PUBLISHED: "accent",
  APPLICATIONS_CLOSED: "warning",
  IN_PROGRESS: "neutral",
  COMPLETED: "neutral",
  CANCELLED: "danger",
};

const POST_TONES: Record<PostStatus, BadgeTone> = {
  SUBMITTED: "neutral",
  VERIFYING: "warning",
  VERIFIED: "accent",
  REJECTED: "danger",
};

export function PostStatusBadge({ status }: { status: PostStatus }) {
  return (
    <Badge tone={POST_TONES[status]}>{POST_STATUS_LABELS[status]}</Badge>
  );
}

/**
 * Minimal post view shared by the Stage 9 verified-view UI helpers. Both the
 * creator and advertiser services return this shape.
 */
export type VerifiedViewPostView = {
  status: PostStatus;
  lastSyncedAt: Date | null;
  createdAt: Date;
  platform: import("@/types").Platform;
};

/**
 * Retryable provider situations (pending verification, missing connection,
 * provider outage) all present the same neutral status: verification is
 * pending — never an error, never an accusation.
 */
const RETRYABLE_VIEW_STATUSES: ReadonlySet<PostStatus> = new Set([
  "SUBMITTED",
  "VERIFYING",
]);

export function isRetryableVerificationView(
  post: Pick<VerifiedViewPostView, "status">,
): boolean {
  return RETRYABLE_VIEW_STATUSES.has(post.status);
}

/**
 * Neutral label for the verification display state. VERIFIED shows the
 * actual status; everything still in flight reads "Verification pending".
 */
export function verificationDisplayLabel(
  post: Pick<VerifiedViewPostView, "status">,
): string {
  if (isRetryableVerificationView(post)) {
    return "Verification pending";
  }

  return POST_STATUS_LABELS[post.status];
}

/**
 * Badge pairing the verification display label with the status tone.
 * Retryable states keep the warning tone so progress stays visible.
 */
export function VerifiedViewBadge({
  post,
}: {
  post: Pick<VerifiedViewPostView, "status">;
}) {
  const tone = isRetryableVerificationView(post)
    ? "warning"
    : POST_TONES[post.status];

  return <Badge tone={tone}>{verificationDisplayLabel(post)}</Badge>;
}

export function ApplicationStatusBadge({
  status,
}: {
  status: ApplicationStatus;
}) {
  return (
    <Badge tone={APPLICATION_TONES[status]}>
      {APPLICATION_STATUS_LABELS[status]}
    </Badge>
  );
}

export function SocialAccountStatusBadge({
  status,
}: {
  status: SocialAccountStatus;
}) {
  return (
    <Badge tone={SOCIAL_ACCOUNT_TONES[status]}>
      {SOCIAL_ACCOUNT_STATUS_LABELS[status]}
    </Badge>
  );
}

export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  return (
    <Badge tone={CAMPAIGN_TONES[status]}>{CAMPAIGN_STATUS_LABELS[status]}</Badge>
  );
}

/**
 * Neutral badge for the latest verified observation's integrity status
 * (Stage 9C). Only CLEAN and REVIEW are displayable — REJECTED observations
 * never become the latest VERIFIED observation. REVIEW keeps its literal
 * label: a flag needing additional verification, never fraud/bot language.
 */
export function IntegrityBadge({
  integrity,
}: {
  integrity: "CLEAN" | "REVIEW";
}) {
  if (integrity === "REVIEW") {
    return <Badge tone="warning">{INTEGRITY_LABELS.REVIEW}</Badge>
  }

  return <Badge tone="neutral">{INTEGRITY_LABELS.CLEAN}</Badge>;
}
