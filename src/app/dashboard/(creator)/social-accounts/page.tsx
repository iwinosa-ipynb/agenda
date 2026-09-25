import type { Metadata } from "next";

import { ConnectedAccountsPanel } from "@/components/dashboard/creator/connected-accounts-panel";
import { PageHeader } from "@/components/dashboard/page-header";
import { RemoveSocialAccountButton } from "@/components/dashboard/creator/remove-social-account-button";
import { SocialAccountForm } from "@/components/dashboard/creator/social-account-form";
import { SocialAccountStatusBadge } from "@/components/dashboard/status-badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PLATFORM_LABELS } from "@/lib/constants";
import { getViewerCreator } from "@/services/creator.service";
import {
  listCreatorConnectedAccounts,
  listSocialAccounts,
} from "@/services/social-account.service";

export const metadata: Metadata = {
  title: "Social accounts",
};

export default async function SocialAccountsPage({
  searchParams,
}: PageProps<"/dashboard/social-accounts">) {
  const { profile } = await getViewerCreator();
  const [accounts, connectedAccounts, flowResult] = await Promise.all([
    listSocialAccounts(profile.id),
    listCreatorConnectedAccounts(profile.id),
    searchParams,
  ]);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8">
      <PageHeader
        title="Social accounts"
        description="Tell us where you publish. Accounts stay pending until platform verification exists."
      />

      <Card className="p-6 sm:p-8">
        <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
          Connected accounts
        </h2>
        <p className="mt-1 text-sm text-ink-soft">
          Connect with the official platform sign-in. This is how Agenda proves
          your submitted posts belong to you — a connected account is the only
          way verification can confirm ownership.
        </p>

        {typeof flowResult.connect === "string" ? (
          <FlowResultBanner platform={flowResult.connect} searchParams={flowResult} />
        ) : null}

        <div className="mt-4">
          <ConnectedAccountsPanel accounts={connectedAccounts} />
        </div>
      </Card>

      <Card className="p-6 sm:p-8">
        <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
          Add an account
        </h2>
        <p className="mt-1 text-sm text-ink-soft">
          TikTok and X are supported first. More platforms are coming.
        </p>
        <div className="mt-6">
          <SocialAccountForm />
        </div>
      </Card>

      <Card className="p-6 sm:p-8">
        <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
          Your accounts
        </h2>

        {accounts.length === 0 ? (
          <div className="mt-6">
            <EmptyState
              title="No accounts linked yet"
              description="Add your TikTok or X account so advertisers can see where your content lives."
            />
          </div>
        ) : (
          <ul className="mt-4 divide-y divide-line">
            {accounts.map((account) => (
              <li
                key={account.id}
                className="flex flex-wrap items-center justify-between gap-4 py-4"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink">
                      {PLATFORM_LABELS[account.platform]}
                    </span>
                    <SocialAccountStatusBadge status={account.status} />
                  </div>
                  <p className="truncate text-sm text-ink-soft">
                    @{account.username}
                  </p>
                  <a
                    href={account.profileUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="block truncate text-xs text-accent underline-offset-4 hover:underline"
                  >
                    {account.profileUrl}
                  </a>
                  {account.followerCount === null ? (
                    <p className="text-xs text-ink-faint">
                      Follower count will come from the platform once
                      verification is available.
                    </p>
                  ) : null}
                </div>

                <RemoveSocialAccountButton accountId={account.id} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="text-xs leading-relaxed text-ink-faint">
        Nothing here is marked as verified automatically. Verification requires a
        real platform API check, which is not connected yet.
      </p>
    </div>
  );
}

/** Post-OAuth-flow status banner. Never echoes provider error text. */
function FlowResultBanner({
  platform,
  searchParams,
}: {
  platform: string;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const label = platform === "x" ? "X" : "TikTok";
  const error = typeof searchParams.error === "string" ? searchParams.error : null;
  const connected = searchParams.status === "connected";

  if (connected) {
    return (
      <div
        role="status"
        className="mt-4 rounded-lg border border-accent/25 bg-accent-soft px-3.5 py-3 text-sm font-medium text-accent-strong"
      >
        {label} account connected.
      </div>
    );
  }

  const messages: Record<string, string> = {
    denied: `You declined the ${label} connection request.`,
    expired: `The ${label} connection attempt expired. Please try again.`,
    state_mismatch: `We couldn't verify the ${label} connection attempt. Please try again.`,
    invalid_response: `${label} returned an unexpected response. Please try again.`,
    exchange_failed: `We couldn't complete the ${label} connection. Please try again.`,
    persist_failed: `We couldn't save the ${label} connection. Please try again.`,
    account_taken: `That ${label} account is already connected to another creator.`,
    not_configured: `${label} sign-in isn't configured on this server yet.`,
    email_unverified:
      "Verify your email address first — you can request a new verification link from your profile page.",
    encryption_unconfigured:
      "The server's token encryption isn't configured, so the connection was refused. Contact support.",
  };

  const message = error ? (messages[error] ?? `The ${label} connection didn't complete.`) : null;

  if (!message) {
    return null;
  }

  return (
    <div
      role="alert"
      className="mt-4 rounded-lg border border-danger/30 bg-danger-soft px-3.5 py-3 text-sm text-danger"
    >
      {message}
    </div>
  );
}
