import { cn } from "@/lib/utils";

export function Progress({
  value,
  label,
  className,
}: {
  value: number;
  label?: string;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));

  return (
    <div className={cn("space-y-2", className)}>
      {label ? (
        <div className="flex items-center justify-between gap-4 text-xs">
          <span className="text-ink-soft">{label}</span>
          <span className="font-medium text-ink">{clamped}%</span>
        </div>
      ) : null}
      <div
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label ?? "Progress"}
        className="h-2 w-full overflow-hidden rounded-full bg-surface-muted"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}
