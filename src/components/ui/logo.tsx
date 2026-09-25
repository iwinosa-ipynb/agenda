import { cn } from "@/lib/utils";

export function Logo({
  className,
  showWordmark = true,
}: {
  className?: string;
  showWordmark?: boolean;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span
        aria-hidden
        className="grid size-7 place-items-center rounded-md bg-ink text-canvas"
      >
        <svg viewBox="0 0 14 14" className="size-3.5" fill="currentColor">
          <path d="M7 1.2 12.8 12.8H1.2L7 1.2Z" />
        </svg>
      </span>
      {showWordmark ? (
        <span className="text-[17px] font-semibold tracking-[-0.01em]">
          Agenda
        </span>
      ) : null}
    </span>
  );
}
