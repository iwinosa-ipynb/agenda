import {
  IntegrityBadge,
  VerifiedViewBadge,
} from "@/components/dashboard/status-badge";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PLATFORM_LABELS } from "@/lib/constants";
import { formatCount, formatDate, formatDateTime } from "@/lib/utils";
import { getViewerAdvertiser } from "@/services/advertiser.service";
import { listAdvertiserCampaignPosts } from "@/services/post.service";
import type { AdvertiserPostSummary } from "@/types";

/**
 * Read-only list of creator submissions across the signed-in advertiser's
 * campaigns. The service scopes every post to the advertiser resolved from the
 * session, so a foreign campaign's posts can never appear here. Metrics are
 * recorded values only — nothing is presented as verified until a real
 * platform verifier exists.
 */
export async function AdvertiserCampaignPostsList({
  campaignId,
}: {
  campaignId?: string;
}) {
  const { profile } = await getViewerAdvertiser();
  const posts = await listAdvertiserCampaignPosts(profile.id, campaignId);

  if (posts.length === 0) {
    return (
      <EmptyState
        title="No content submitted yet"
        description="When accepted creators submit their published posts, they'll appear here for review."
      />
    );
  }

  return (
    <ul className="space-y-4">
      {posts.map((post) => (
        <li key={post.id}>
          <PostCard post={post} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Neutral, status-specific footnote. Integrity REVIEW uses the standard
 * "additional verification required" wording — never an accusation, never
 * internal check details. No fake metrics are implied anywhere.
 */
function advertiserPostFootnote(post: AdvertiserPostSummary): string {
  if (post.integrity === "REVIEW") {
    return "Verification issue — additional verification required. The verified views shown are the platform's most recent confirmed count for this post.";
  }

  switch (post.status) {
    case "VERIFIED":
      return `Verified against ${PLATFORM_LABELS[post.platform]} on ${formatDateTime(
        post.lastSyncedAt ?? post.createdAt,
      )}. Verified views are the platform's latest reported count for this post.`;
    case "VERIFYING":
      return "Verification is running against the platform. Metrics stay hidden until it completes.";
    case "SUBMITTED":
      return "Verification has not run for this post yet. Verified views stay hidden until the platform reports them.";
    case "REJECTED":
      return "This submission did not meet the campaign's verification rules. The creator can submit a replacement post.";
  }
}

function PostCard({ post }: { post: AdvertiserPostSummary }) {
  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1.5">
          <p className="text-xs text-ink-faint">
            {post.creator.name} (@{post.creator.username}) ·{" "}
            {formatDate(post.createdAt)}
          </p>
          <h3 className="text-base font-semibold tracking-[-0.01em] text-ink">
            {post.campaign.title}
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-ink-faint">
              {PLATFORM_LABELS[post.platform]}
            </span>
            <VerifiedViewBadge post={post} />
          </div>
        </div>

        <a
          href={post.postUrl}
          target="_blank"
          rel="noreferrer noopener"
          className={buttonClasses({ variant: "outline", size: "sm" })}
        >
          View post
        </a>
      </div>

      {post.caption ? (
        <p className="mt-4 border-t border-line pt-4 text-sm leading-relaxed text-ink-soft">
          <span className="font-medium text-ink">Caption: </span>
          {post.caption}
        </p>
      ) : null}

      <dl className="mt-4 grid gap-4 border-t border-line pt-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
        <div>
          <dt className="text-xs text-ink-faint">Verified views</dt>
          <dd className="mt-0.5 text-sm font-semibold text-ink">
            {post.status === "VERIFIED" ? formatCount(post.verifiedViews) : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-faint">Likes</dt>
          <dd className="mt-0.5 text-sm font-semibold text-ink">
            {post.status === "VERIFIED" ? formatCount(post.likes) : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-faint">Comments</dt>
          <dd className="mt-0.5 text-sm font-semibold text-ink">
            {post.status === "VERIFIED" ? formatCount(post.comments) : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-faint">Shares</dt>
          <dd className="mt-0.5 text-sm font-semibold text-ink">
            {post.status === "VERIFIED" ? formatCount(post.shares) : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-faint">Last verified</dt>
          <dd className="mt-0.5 text-sm text-ink">
            {post.lastSyncedAt ? formatDateTime(post.lastSyncedAt) : "Not yet"}
          </dd>
        </div>
      </dl>

      {post.status === "VERIFIED" ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink-faint">Integrity</span>
          <IntegrityBadge integrity={post.integrity} />
        </div>
      ) : null}

      <p className="mt-4 rounded-lg border border-dashed border-line-strong bg-surface-muted px-3.5 py-3 text-xs leading-relaxed text-ink-soft">
        {advertiserPostFootnote(post)}
      </p>
    </Card>
  );
}
