import { cn } from "@/lib/utils";

export function SectionHeading({
  eyebrow,
  title,
  description,
  align = "left",
  className,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  align?: "left" | "center";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "max-w-2xl space-y-3",
        align === "center" && "mx-auto text-center",
        className,
      )}
    >
      {eyebrow ? (
        <p className="text-xs font-semibold tracking-[0.14em] text-accent uppercase">
          {eyebrow}
        </p>
      ) : null}
      <h2 className="font-display text-3xl leading-[1.1] tracking-[-0.02em] text-ink sm:text-4xl">
        {title}
      </h2>
      {description ? (
        <p className="text-base leading-relaxed text-ink-soft">{description}</p>
      ) : null}
    </div>
  );
}
