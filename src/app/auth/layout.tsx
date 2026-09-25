import Link from "next/link";
import type { ReactNode } from "react";

import { Logo } from "@/components/ui/logo";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="mx-auto flex h-16 w-full max-w-6xl items-center px-5 sm:px-8">
        <Link href="/" aria-label="Agenda home">
          <Logo />
        </Link>
      </header>

      <main className="flex flex-1 items-center justify-center px-5 py-12 sm:px-8">
        <div className="flex w-full justify-center">{children}</div>
      </main>
    </div>
  );
}
