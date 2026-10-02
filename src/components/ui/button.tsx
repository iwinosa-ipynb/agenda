import type { ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export type ButtonVariant =
  | "primary"
  | "accent"
  | "outline"
  | "ghost"
  | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const BASE =
  "inline-flex select-none items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition-[color,background-color,border-color,transform,opacity] duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas active:scale-[0.97] active:duration-75 motion-reduce:active:scale-100 disabled:pointer-events-none disabled:opacity-55";

// Pressed feedback per variant. A press is confirmed even when the button is
// already showing its hover colour (e.g. a keyboard/tap "click" on touch),
// so mobile users get a visible response instead of nothing.
const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-ink text-canvas hover:bg-ink/88 active:bg-ink/80",
  accent: "bg-accent text-white hover:bg-accent-strong active:bg-accent-strong",
  outline:
    "border border-line-strong bg-surface text-ink hover:bg-surface-muted active:bg-surface-muted active:border-ink/25",
  ghost:
    "text-ink-soft hover:bg-surface-muted hover:text-ink active:bg-surface-muted active:text-ink",
  danger: "bg-danger text-white hover:bg-danger/90 active:bg-danger/80",
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
