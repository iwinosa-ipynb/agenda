import type { ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export type ButtonVariant =
  | "primary"
  | "accent"
  | "outline"
  | "ghost"
  | "danger";
export type ButtonSize = "sm" | "md" | "lg";

// `pressed:` (see globals.css) matches both the real `:active` state and the
// `data-pressed` attribute set by <PressFeedback>, so the press reads on touch
// devices where `:active` alone is unreliable — iOS Safari in particular only
// honours `:active` once the page handles touch. `transition-[...,scale,...]` is
// required because Tailwind's `scale-*` utilities animate the `scale` property,
// not `transform` — a `transition-transform` (or a list that omits `scale`)
// makes the press snap instead of animate.
const BASE =
  "inline-flex select-none items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition-[color,background-color,border-color,scale,opacity] duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas pressed:scale-[0.96] pressed:duration-75 motion-reduce:pressed:scale-100 disabled:pointer-events-none disabled:opacity-55";

// Pressed feedback per variant.
//
// Each pressed colour is a large, obvious step away from the resting colour
// (see the `*-pressed` tokens in globals.css), so the press is unmistakable
// even on touch where no hover colour applies and no pointer exists. Light
// surfaces step darker; the near-black primary button cannot go darker, so it
// steps lighter — the conventional pressed cue on a dark surface.
const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-ink text-canvas hover:bg-ink/88 pressed:bg-ink-pressed",
  accent:
    "bg-accent text-white hover:bg-accent-strong pressed:bg-accent-pressed",
  outline:
    "border border-line-strong bg-surface text-ink hover:bg-surface-muted pressed:border-ink/30 pressed:bg-line-strong",
  ghost:
    "text-ink-soft hover:bg-surface-muted hover:text-ink pressed:bg-line-strong pressed:text-ink",
  danger:
    "bg-danger text-white hover:bg-danger/90 pressed:bg-danger-pressed",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-9 px-3.5 text-sm",
  md: "h-11 px-4 text-sm",
  lg: "h-12 px-6 text-[15px]",
};

export function buttonClasses({
  variant = "primary",
  size = "md",
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} = {}): string {
  return cn(BASE, VARIANTS[variant], SIZES[size], className);
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClasses({ variant, size, className })}
      {...props}
    />
  );
}
