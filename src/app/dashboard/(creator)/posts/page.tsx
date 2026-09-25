import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/dashboard/page-header";
import {
  IntegrityBadge,
  PostStatusBadge,
} from "@/components/dashboard/status-badge";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PLATFORM_LABELS } from "@/lib/constants";
import type { PostStatus } from "@/types";
import {
  formatVerifiedMetric,
  getVerifiedViewsNote,
  getLastVerifiedLabel,
  INTEGRITY_NOTES,
  VERIFICATION_STATE_LABELS,
  getVerificationDisplayState,
} from "@/lib/verified-view-display";
import { formatDate } from "@/lib/utils";
import { requireViewerCreatorId } from "@/services/creator.service";
import { listCreatorCampaignPosts } from "@/services/post.service";

export const metadata: Metadata = {
  title: "My posts",
};

/**
 * Status-specific, neutral explainer text for posts without verified metrics
 * yet (AWAITING / PENDING / REJECTED). No fake metrics, no accusations: every
 * branch states only what the verification lifecycle actually knows.
 */
function statusExplainer(status: PostStatus): string {
  return (
    getVerifiedViewsNote(status) ??
    "Awaiting verification — verified views stay hidden until the platform reports them."
  );
}

export default async function CreatorPostsPage() {
  const creatorId = await requireViewerCreatorId();

  let posts;
  try {
    posts = await listCreatorCampaignPosts(creatorId);
  } catch (error) {
    console.error("creator-posts:load-failed", error);
    return (
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <PageHeader
          title="My posts"
          description="Content you've submitted for active campaigns. Verified views come from official platform verification — never entered manually."
        />
        <EmptyState
          title="Could not load your posts"
          description="Something went wrong while loading your submissions. Please try again in a moment."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <PageHeader
        title="My posts"
        description="Content you've submitted for active campaigns. Verified views come from official platform verification — never entered manually."
      />

      {posts.length === 0 ? (
        <EmptyState
          title="No content submitted yet"
          description="When you publish content for a campaign you've been accepted into, submit the link from your active campaigns page."
          action={
            <Link
              href="/dashboard/active-campaigns"
              className={buttonClasses({ variant: "outline", size: "sm" })}
            >
              View active campaigns
            </Link>
          }
        />
      ) : (
        <ul className="space-y-4">
          {posts.map((post) => {
            const displayState = getVerificationDisplayState(post.status);

            return (
              <li key={post.id}>
                <Card className="p-5 sm:p-6">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0 space-y-1.5">
                      <p className="text-xs text-ink-faint">
                        {post.campaign.advertiser.companyName}
                      </p>
                      <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
                        <Link
                          href={`/dashboard/campaigns/${post.campaign.id}`}
                          className="hover:text-accent hover:underline"
                        >
                          {post.campaign.title}
                        </Link>
                      </h2>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-ink-faint">
                          {PLATFORM_LABELS[post.platform]} ·{" "}
                          {formatDate(post.createdAt)}
                        </span>
                        <PostStatusBadge status={post.status} />
                        {displayState === "PENDING" ? (
                          <span className="text-xs text-ink-soft">
                            {VERIFICATION_STATE_LABELS.PENDING}
                          </span>
                        ) : null}
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

                  <dl className="mt-5 grid gap-4 border-t border-line pt-4 sm:grid-cols-2 lg:grid-cols-4">
                    <div>
                      <dt className="text-xs text-ink-faint">Verified views</dt>
                      <dd className="mt-0.5 text-sm font-semibold text-ink">
                        {formatVerifiedMetric(post.status, post.verifiedViews)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-ink-faint">Likes</dt>
                      <dd className="mt-0.5 text-sm font-semibold text-ink">
                        {formatVerifiedMetric(post.status, post.likes)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-ink-faint">Comments</dt>
                      <dd className="mt-0.5 text-sm font-semibold text-ink">
                        {formatVerifiedMetric(post.status, post.comments)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-ink-faint">Shares</dt>
                      <dd className="mt-0.5 text-sm font-semibold text-ink">
                        {formatVerifiedMetric(post.status, post.shares)}
                      </dd>
                    </div>
                  </dl>

                  <dl className="mt-4 grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
                    <div>
                      <dt className="text-xs text-ink-faint">Last verified</dt>
                      <dd className="mt-0.5 text-sm text-ink">
                        {getLastVerifiedLabel(post.lastSyncedAt, post.status)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-ink-faint">Submitted</dt>
                      <dd className="mt-0.5 text-sm text-ink">
                        {formatDate(post.createdAt)}
                      </dd>
                    </div>
                  </dl>

                  {displayState === "VERIFIED" ? (
                    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
                      <span className="text-xs text-ink-faint">Integrity</span>
                      <IntegrityBadge integrity={post.integrity} />
                    </div>
                  ) : null}

                  {post.integrity === "REVIEW" &&
                  INTEGRITY_NOTES.REVIEW &&
                  displayState === "VERIFIED" ? (
                    <p className="mt-4 rounded-lg border border-dashed border-line-strong bg-surface-muted px-3.5 py-3 text-xs leading-relaxed text-ink-soft">
                      {INTEGRITY_NOTES.REVIEW}
                    </p>
                  ) : null}

                  {displayState !== "VERIFIED" ? (
                    <p className="mt-4 rounded-lg border border-dashed border-line-strong bg-surface-muted px-3.5 py-3 text-xs leading-relaxed text-ink-soft">
                      {statusExplainer(post.status)}
                    </p>
                  ) : null}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
