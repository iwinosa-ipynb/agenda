import { Card } from "@/components/ui/card";

export function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card className="p-5">
      <p className="text-xs text-ink-faint">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-[-0.01em] text-ink">
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-ink-faint">{hint}</p> : null}
    </Card>
  );
}
