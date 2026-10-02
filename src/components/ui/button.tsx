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
// `data-pressed` attribute set by <PressFeedback>, so the press reads on iOS
// Safari where `:active` alone is unreliable. `transition-[...,scale,...]` is
// required because Tailwind's `scale-*` utilities animate the `scale` property,
// not `transform`.
const BASE =
  "inline-flex select-none items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition-[color,background-color,border-color,scale,opacity] duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas pressed:scale-[0.96] pressed:duration-75 motion-reduce:pressed:scale-100 disabled:pointer-events-none disabled:opacity-55";

// Pressed feedback per variant. Every pressed colour is darker than both the
// base and the hover colour, so a press is clearly visible even on touch where
// the hover colour may already be showing.
const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-ink text-canvas hover:bg-ink/88 pressed:bg-ink/70",
  accent:
    "bg-accent text-white hover:bg-accent-strong pressed:bg-accent-pressed",
  outline:
    "border border-line-strong bg-surface text-ink hover:bg-surface-muted pressed:border-ink/25 pressed:bg-line",
  ghost:
    "text-ink-soft hover:bg-surface-muted hover:text-ink pressed:bg-line pressed:text-ink",
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
