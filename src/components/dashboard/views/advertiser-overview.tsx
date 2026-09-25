import Link from "next/link";

import { PageHeader } from "@/components/dashboard/page-header";
import { StatCard } from "@/components/dashboard/stat-card";
import { buttonClasses } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  computeAdvertiserProfileCompletion,
  getAdvertiserDashboardStats,
  getViewerAdvertiser,
} from "@/services/advertiser.service";
import { formatMoney } from "@/lib/utils";

const QUICK_LINKS = [
  { href: "/dashboard/campaigns", label: "My campaigns" },
  { href: "/dashboard/campaigns/new", label: "Create campaign" },
  { href: "/dashboard/applications", label: "Applications" },
  { href: "/dashboard/profile", label: "Company profile" },
];

export async function AdvertiserOverview() {
  const { profile } = await getViewerAdvertiser();
  const [stats, completion] = await Promise.all([
    getAdvertiserDashboardStats(profile.id),
    Promise.resolve(computeAdvertiserProfileCompletion(profile)),
  ]);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-8">
      <PageHeader
        eyebrow={profile.companyName}
        title={`Hello, ${profile.name?.split(" ")[0] ?? "there"}`}
        description="Launch campaigns on TikTok and X, review creator quotes, and work with the creators you accept."
        action={
          <Link
            href="/dashboard/campaigns/new"
            className={buttonClasses({ variant: "accent", size: "sm" })}
          >
            Create campaign
          </Link>
        }
      />

      <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Total campaigns"
          value={String(stats.totalCampaigns)}
        />
        <StatCard
          label="Published campaigns"
          value={String(stats.activeCampaigns)}
        />
        <StatCard
          label="Pending applications"
          value={String(stats.pendingApplications)}
        />
        <StatCard
          label="Total campaign budget"
          value={formatMoney(
            stats.totalBudget.amount,
            stats.totalBudget.currency,
          )}
          hint="Budgets across all your campaigns"
        />
      </dl>

      <Card className="p-6 sm:p-8">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <h2 className="text-lg font-semibold tracking-[-0.01em] text-ink">
              Company profile
            </h2>
            <p className="max-w-md text-sm leading-relaxed text-ink-soft">
              Creators see your company profile with every campaign. Complete
              it so they can judge whether your brand fits their content.
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

      <nav
        aria-label="Advertiser shortcuts"
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        {QUICK_LINKS.map((link) => (
          <Link key={link.href} href={link.href} className="group block h-full">
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
