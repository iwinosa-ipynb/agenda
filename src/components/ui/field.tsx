import type {
  InputHTMLAttributes,
  LabelHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

import { cn } from "@/lib/utils";

export function Label({
  className,
  ...props
}: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn("text-sm font-medium text-ink", className)}
      {...props}
    />
  );
}

export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-ink-faint">{hint}</p>
      ) : null}
    </div>
  );
}

const CONTROL =
  "w-full rounded-lg border bg-surface text-sm text-ink shadow-xs transition-colors placeholder:text-ink-faint focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/10";

export function Input({
  className,
  invalid,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      className={cn(
        CONTROL,
        "h-11 px-3.5",
        invalid
          ? "border-danger focus:border-danger"
          : "border-line focus:border-accent",
        className,
      )}
      aria-invalid={invalid || undefined}
      {...props}
    />
  );
}

export function Textarea({
  className,
  invalid,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      className={cn(
        CONTROL,
        "min-h-28 resize-y px-3.5 py-3",
        invalid
          ? "border-danger focus:border-danger"
          : "border-line focus:border-accent",
        className,
      )}
      aria-invalid={invalid || undefined}
      {...props}
    />
  );
}

export function Select({
  className,
  invalid,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select
      className={cn(
        CONTROL,
        "h-11 px-3",
        invalid
          ? "border-danger focus:border-danger"
          : "border-line focus:border-accent",
        className,
      )}
      aria-invalid={invalid || undefined}
      {...props}
    />
  );
}
