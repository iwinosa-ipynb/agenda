"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Badge } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type DashboardNavItem = {
  href: string;
  label: string;
  available?: boolean;
};

export function DashboardNav({
  items,
  orientation = "vertical",
}: {
  items: DashboardNavItem[];
  orientation?: "vertical" | "horizontal";
}) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Dashboard"
      className={cn(
        orientation === "vertical"
          ? "space-y-1"
          : "flex items-center gap-1 overflow-x-auto",
      )}
    >
      {items.map((item) => {
        const isActive = pathname === item.href;

        if (!item.available) {
          return (
            <span
              key={item.href}
              aria-disabled="true"
              className={cn(
                "flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-ink-faint",
                orientation === "horizontal" && "shrink-0 whitespace-nowrap",
              )}
            >
              {item.label}
              <Badge tone="muted" className="px-2 py-0.5 text-[10px]">
                Soon
              </Badge>
            </span>
          );
        }

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "flex items-center rounded-lg px-3 py-2 text-sm font-medium transition-[color,background-color,border-color,scale] duration-150 ease-out pressed:scale-[0.97] motion-reduce:pressed:scale-100",
              orientation === "horizontal" && "shrink-0 whitespace-nowrap",
              isActive
                ? "bg-ink text-canvas pressed:bg-ink-pressed"
                : "text-ink-soft hover:bg-surface-muted hover:text-ink pressed:bg-line-strong pressed:text-ink",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
