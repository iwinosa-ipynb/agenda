import type { SVGProps } from "react";

import { cn } from "@/lib/utils";

type IconProps = SVGProps<SVGSVGElement>;

const BASE = "size-5";

function Icon({ className, children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn(BASE, className)}
      {...props}
    >
      {children}
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 6 9 17l-5-5" />
    </Icon>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3l7 3v5.5c0 4.6-3 7.9-7 9.5-4-1.6-7-4.9-7-9.5V6l7-3Z" />
      <path d="M9 12l2 2 4-4" />
    </Icon>
  );
}

export function TrendIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 17l6-6 4 4 7-7" />
      <path d="M17 8h4v4" />
    </Icon>
  );
}

export function WalletIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 8a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z" />
      <path d="M3 8l2-3h13l1 3" />
      <circle cx="16" cy="12.5" r="1" />
    </Icon>
  );
}

export function UsersIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20a6 6 0 0 1 12 0" />
      <path d="M16 6.5a3 3 0 0 1 0 5.5" />
      <path d="M17.5 14.6A6 6 0 0 1 21 20" />
    </Icon>
  );
}

export function TargetIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </Icon>
  );
}
