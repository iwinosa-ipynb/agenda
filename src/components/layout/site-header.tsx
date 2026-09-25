import Link from "next/link";

import { buttonClasses } from "@/components/ui/button";
import { Logo } from "@/components/ui/logo";

const NAV_LINKS = [
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#creators", label: "For creators" },
  { href: "/#advertisers", label: "For advertisers" },
  { href: "/#trust", label: "Trust & safety" },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-canvas/85 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-6 px-5 sm:px-8">
        <Link href="/" aria-label="Agenda home" className="shrink-0">
          <Logo />
        </Link>

        <nav className="hidden items-center gap-8 text-sm text-ink-soft lg:flex">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="transition-colors hover:text-ink"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-1.5">
          <Link
            href="/auth/login"
            className={buttonClasses({ variant: "ghost", size: "sm" })}
          >
            Log in
          </Link>
          <Link
            href="/auth/register"
            className={buttonClasses({ variant: "primary", size: "sm" })}
          >
            Get started
          </Link>
        </div>
      </div>
    </header>
  );
}
