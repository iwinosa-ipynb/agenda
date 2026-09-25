import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-xl border border-line bg-surface", className)}
      {...props}
    />
  );
}

export type BadgeTone =
  | "neutral"
  | "accent"
  | "muted"
  | "warning"
  | "danger";

export function Badge({
  className,
  tone = "neutral",
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        tone === "accent" && "bg-accent-soft text-accent-strong",
        tone === "neutral" && "border border-line bg-surface text-ink-soft",
        tone === "muted" && "bg-surface-muted text-ink-soft",
        tone === "warning" && "bg-warning-soft text-warning",
        tone === "danger" && "bg-danger-soft text-danger",
        className,
      )}
      {...props}
    />
  );
}
