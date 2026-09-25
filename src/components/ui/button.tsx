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
  "inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:pointer-events-none disabled:opacity-55";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-ink text-canvas hover:bg-ink/88",
  accent: "bg-accent text-white hover:bg-accent-strong",
  outline: "border border-line-strong bg-surface text-ink hover:bg-surface-muted",
  ghost: "text-ink-soft hover:bg-surface-muted hover:text-ink",
  danger: "bg-danger text-white hover:bg-danger/90",
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
