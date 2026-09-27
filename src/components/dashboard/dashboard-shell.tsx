import Link from "next/link";
import type { ReactNode } from "react";

import { signOutAction } from "@/app/dashboard/actions";
import {
  DashboardNav,
  type DashboardNavItem,
} from "@/components/dashboard/dashboard-nav";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { Logo } from "@/components/ui/logo";
import { ROLE_LABELS } from "@/lib/constants";
import type { SessionUser } from "@/lib/authz";
import type { UserRole } from "@/types";

// Creator and advertiser navigation are deliberately separate, but several
// destinations are shared routes that render different views per role.
// Stage 14D: SUPPORT gets a minimal operational destination (overview +
// milestone reviews). It is NOT an admin dashboard — no staff/role
// management exists, and support accounts are created operationally.
const NAV_ITEMS: Record<UserRole, DashboardNavItem[]> = {
  CREATOR: [
    { href: "/dashboard", label: "Overview", available: true },
    { href: "/dashboard/campaigns", label: "Campaigns", available: true },
    { href: "/dashboard/applications", label: "Applications", available: true },
    {
      href: "/dashboard/active-campaigns",
      label: "Active campaigns",
      available: true,
    },
    { href: "/dashboard/posts", label: "My posts", available: true },
    {
      href: "/dashboard/social-accounts",
      label: "Social accounts",
      available: true,
    },
    {
      href: "/dashboard/rate-card",
      label: "Rate card",
      available: true,
    },
    {
      href: "/dashboard/payouts",
      label: "Payout account",
      available: true,
    },
    { href: "/dashboard/profile", label: "Profile", available: true },
  ],
  ADVERTISER: [
    { href: "/dashboard", label: "Overview", available: true },
    { href: "/dashboard/campaigns", label: "Campaigns", available: true },
    {
      href: "/dashboard/campaigns/new",
      label: "Create campaign",
      available: true,
    },
    { href: "/dashboard/applications", label: "Applications", available: true },
    // Agenda Managed (V1): the advertiser's private briefs to Agenda.
    { href: "/dashboard/managed", label: "Managed", available: true },
    { href: "/dashboard/profile", label: "Profile", available: true },
  ],
  SUPPORT: [
    { href: "/dashboard", label: "Overview", available: true },
    { href: "/dashboard/support", label: "Support", available: true },
    // Agenda Managed (V1 slice 2): support review of submitted briefs.
    {
      href: "/dashboard/support/managed",
      label: "Managed briefs",
      available: true,
    },
  ],
};

function initialsOf(name: string | null | undefined): string {
  if (!name) {
    return "?";
  }

  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function UserMeta({ user }: { user: SessionUser }) {
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-ink text-xs font-semibold text-canvas">
        {initialsOf(user.name)}
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-ink">
          {user.name ?? "Account"}
        </p>
        <p className="truncate text-xs text-ink-faint">
          {ROLE_LABELS[user.role]}
        </p>
      </div>
    </div>
  );
}

export function DashboardShell({
  user,
  children,
}: {
  user: SessionUser;
  children: ReactNode;
}) {
  const items = NAV_ITEMS[user.role];

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-line bg-surface lg:flex">
        <div className="flex h-16 items-center border-b border-line px-5">
          <Link href="/" aria-label="Agenda home">
            <Logo />
          </Link>
        </div>

        <div className="flex-1 p-3">
          <DashboardNav items={items} />
        </div>

        <div className="space-y-4 border-t border-line p-4">
          <UserMeta user={user} />
          <form action={signOutAction}>
            <Button variant="outline" size="sm" type="submit" className="w-full">
              Log out
            </Button>
          </form>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 items-center justify-between gap-4 border-b border-line bg-surface px-5 lg:px-8">
          <Link href="/" aria-label="Agenda home" className="lg:hidden">
            <Logo showWordmark={false} />
          </Link>

          <div className="hidden lg:block">
            <Badge tone="neutral">{ROLE_LABELS[user.role]} account</Badge>
          </div>

          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-ink-soft sm:inline">
              {user.email}
            </span>
            <form action={signOutAction} className="lg:hidden">
              <Button variant="outline" size="sm" type="submit">
                Log out
              </Button>
            </form>
          </div>
        </header>

        <div className="border-b border-line bg-surface px-3 py-2 lg:hidden">
          <DashboardNav items={items} orientation="horizontal" />
        </div>

        <main className="flex-1 p-5 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
