import Link from "next/link";

import { PageHeader } from "@/components/dashboard/page-header";
import { StatCard } from "@/components/dashboard/stat-card";
import { buttonClasses } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { formatCount } from "@/lib/utils";
import type {
  CreatorDashboardStats,
  CreatorProfileCompletion,
  CreatorProfileSummary,
} from "@/types";

const QUICK_LINKS = [
  { href: "/dashboard/campaigns", label: "Find campaigns" },
  { href: "/dashboard/applications", label: "My applications" },
  { href: "/dashboard/active-campaigns", label: "Active campaigns" },
  { href: "/dashboard/social-accounts", label: "Social accounts" },
];

export function CreatorOverview({
  profile,
  completion,
  stats,
  verifiedViewSummary,
}: {
  profile: CreatorProfileSummary;
  completion: CreatorProfileCompletion;
  stats: CreatorDashboardStats;
  /** Server-computed by the Stage 9A accounting service; null when unavailable. */
  verifiedViewSummary: {
    totalVerifiedViews: number;
    verifiedPostCount: number;
    submittedPostCount: number;
  } | null;
}) {
  const firstName = profile.name.split(" ")[0] ?? "there";

  return (
    <div className="mx-auto w-full max-w-6xl space-y-8">
      <PageHeader
        eyebrow={`@${profile.username}`}
        title={`Hello, ${firstName}`}
        description="Discover campaigns, apply to the ones that fit your audience, and track your verified performance."
        action={
          <Link
            href="/dashboard/campaigns"
            className={buttonClasses({ variant: "accent", size: "sm" })}
          >
            Find campaigns
          </Link>
        }
      />

      <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          label="Available campaigns"
          value={String(stats.availableCampaigns)}
        />
        <StatCard
          label="Applications"
          value={String(stats.totalApplications)}
          hint={`${stats.pendingApplications} pending`}
        />
        <StatCard
          label="Active campaigns"
          value={String(stats.activeCampaigns)}
        />
        <StatCard
          label="Verified views"
          value={
            verifiedViewSummary
              ? formatCount(verifiedViewSummary.totalVerifiedViews)
              : "—"
          }
          hint={
            verifiedViewSummary
              ? `${verifiedViewSummary.verifiedPostCount} verified post${
                  verifiedViewSummary.verifiedPostCount === 1 ? "" : "s"
                }`
              : "Unavailable right now"
          }
        />
        <StatCard
          label="Posts awaiting verification"
          value={
            verifiedViewSummary
              ? String(verifiedViewSummary.submittedPostCount)
              : "—"
          }
          hint="Submitted or verifying right now"
        />
        <StatCard
          label="How you get paid"
          value="Fixed milestones"
          hint="Your agreed price, released as milestones are confirmed"
        />
      </dl>

      <Card className="p-6 sm:p-8">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <h2 className="text-lg font-semibold tracking-[-0.01em] text-ink">
              Profile completion
            </h2>
            <p className="max-w-md text-sm leading-relaxed text-ink-soft">
              Advertisers will see your profile. Complete it so brands can judge
              whether your audience fits their campaign.
            </p>
          </div>
          <Link
            href="/dashboard/profile"
            className={buttonClasses({ variant: "outline", size: "sm" })}
          >
            Edit profile
          </Link>
        </div>

        <Progress
          className="mt-6"
          value={completion.percentage}
          label="Profile completion"
        />

        {completion.missing.length > 0 ? (
          <div className="mt-5 space-y-2">
            <p className="text-xs font-medium text-ink-soft">Still to add</p>
            <ul className="flex flex-wrap gap-1.5">
              {completion.missing.map((item) => (
                <li key={item}>
                  <Badge tone="muted">{item}</Badge>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="mt-5 text-sm text-accent-strong">
            Your profile is complete.
          </p>
        )}
      </Card>

      <nav aria-label="Creator shortcuts" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {QUICK_LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="group block h-full rounded-xl transition-transform duration-150 ease-out active:scale-[0.99] motion-reduce:active:scale-100"
          >
            <Card className="flex h-full items-center justify-between p-5 transition-colors group-hover:border-line-strong">
              <span className="text-sm font-medium text-ink">
                {link.label}
              </span>
              <span aria-hidden className="text-ink-faint">
                →
              </span>
            </Card>
          </Link>
        ))}
      </nav>
    </div>
  );
}
