import Image from "next/image";

function initialsOf(name: string): string {
  return (
    name
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

export function Avatar({
  name,
  imageUrl,
  size = 80,
}: {
  name: string;
  imageUrl: string | null;
  size?: number;
}) {
  if (imageUrl) {
    return (
      <Image
        src={imageUrl}
        alt=""
        width={size}
        height={size}
        className="shrink-0 rounded-full border border-line object-cover"
        style={{ width: size, height: size }}
        unoptimized
      />
    );
  }

  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-full border border-line bg-surface-muted text-ink-soft"
      style={{ width: size, height: size }}
    >
      <span className="text-lg font-semibold">{initialsOf(name)}</span>
    </span>
  );
}
