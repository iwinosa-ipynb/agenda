import { DisconnectPlatformButton } from "@/components/dashboard/creator/disconnect-platform-button";
import { buttonClasses } from "@/components/ui/button";
import type { ConnectedAccountSummary } from "@/services/social-account.service";

/**
 * Connected-accounts panel. Renders ONLY what ConnectedAccountSummary
 * exposes — which by construction contains no token material — plus static
 * links into the server-side OAuth start routes. The creator's choice of
 * "Connect" never carries identity data; identity is established by the
 * provider during the redirect flow.
 */
export function ConnectedAccountsPanel({
  accounts,
}: {
  accounts: ConnectedAccountSummary[];
}) {
  const platforms: Array<{
    key: "TIKTOK" | "X";
    label: string;
    startHref: string;
  }> = [
    { key: "X", label: "X", startHref: "/api/social-connections/x" },
    {
      key: "TIKTOK",
      label: "TikTok",
      startHref: "/api/social-connections/tiktok",
    },
  ];

  return (
    <ul className="divide-y divide-line">
      {platforms.map((platform) => {
        const connected = accounts.find(
          (account) =>
            account.platform === platform.key && account.connectedAt !== null,
        );

        return (
          <li
            key={platform.key}
            className="flex flex-wrap items-center justify-between gap-4 py-4"
          >
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-ink">
                  {platform.label}
                </span>
                <span
                  className={
                    connected
                      ? "rounded-full border border-accent/30 bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent-strong"
                      : "rounded-full border border-line bg-surface-muted px-2 py-0.5 text-xs text-ink-soft"
                  }
                >
                  {connected ? "Connected" : "Not connected"}
                </span>
              </div>

              {connected ? (
                <>
                  <p className="truncate text-sm text-ink-soft">
                    @{connected.username}
                    {connected.tokenExpired && !connected.refreshable
                      ? " · reconnect needed"
                      : ""}
                  </p>
                  <p className="text-xs text-ink-faint">
                    Connected {connected.connectedAt?.toLocaleDateString() ?? ""}
                    {connected.grantedScopes
                      ? ` · scopes: ${connected.grantedScopes}`
                      : ""}
                  </p>
                  {connected.tokenExpired && !connected.refreshable ? (
                    <p className="text-xs text-warning">
                      The {platform.label} authorization expired. Reconnect to
                      let Agenda verify your posts again — your other data is
                      untouched.
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="text-xs text-ink-faint">
                  Connect your account so Agenda can verify that your submitted
                  posts are really yours.
                </p>
              )}
            </div>

            {connected ? (
              <DisconnectPlatformButton
                platform={platform.key}
                label={platform.label}
              />
            ) : (
              <a href={platform.startHref} className={buttonClasses({ variant: "outline", size: "sm" })}>
                Connect {platform.label}
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}
