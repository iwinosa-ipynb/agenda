import Link from "next/link";

import { Logo } from "@/components/ui/logo";

const COLUMNS = [
  {
    heading: "Marketplace",
    links: [
      { href: "/#how-it-works", label: "How it works" },
      { href: "/#creators", label: "For creators" },
      { href: "/#advertisers", label: "For advertisers" },
    ],
  },
  {
    heading: "Get started",
    links: [
      { href: "/auth/register", label: "Create an account" },
      { href: "/auth/login", label: "Log in" },
      { href: "/dashboard", label: "Dashboard" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-canvas">
      <div className="mx-auto w-full max-w-6xl px-5 py-14 sm:px-8">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-3 lg:col-span-2">
            <Logo />
            <p className="max-w-xs text-sm leading-relaxed text-ink-soft">
              A marketplace where brands launch campaigns and creators earn from
              verified audience attention.
            </p>
          </div>

          {COLUMNS.map((column) => (
            <div key={column.heading} className="space-y-3">
              <h3 className="text-xs font-semibold tracking-[0.08em] text-ink-faint uppercase">
                {column.heading}
              </h3>
              <ul className="space-y-2 text-sm">
                {column.links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-ink-soft transition-colors hover:text-ink"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col gap-2 border-t border-line pt-6 text-xs text-ink-faint sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} Agenda. Nigeria.</p>
          <p>
            View verification and payouts are being built. Nothing on this site
            promises guaranteed earnings.
          </p>
        </div>
      </div>
    </footer>
  );
}
