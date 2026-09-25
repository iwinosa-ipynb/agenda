"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";

import { disconnectPlatformAccountAction } from "@/app/dashboard/_actions/social-accounts";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/types";

export function DisconnectPlatformButton({
  platform,
  label,
}: {
  platform: "TIKTOK" | "X";
  label: string;
}) {
  const [state, formAction, isPending] = useActionState<
    ActionResult | null,
    FormData
  >(disconnectPlatformAccountAction, null);
  const router = useRouter();

  useEffect(() => {
    if (state?.success) {
      router.refresh();
    }
  }, [state, router]);

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="platform" value={platform} />
      <Button variant="ghost" size="sm" type="submit" disabled={isPending}>
        {isPending ? "Disconnecting…" : `Disconnect ${label}`}
      </Button>
      {state && !state.success ? (
        <span className="text-xs text-danger" role="alert">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}
