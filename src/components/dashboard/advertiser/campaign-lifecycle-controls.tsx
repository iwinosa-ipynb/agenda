"use client";

import Link from "next/link";
import { useActionState } from "react";

import {
  cancelCampaignAction,
  closeApplicationsAction,
  completeCampaignAction,
  publishCampaignAction,
  startCampaignAction,
} from "@/app/dashboard/_actions/advertiser";
import { buttonClasses } from "@/components/ui/button";
import { FormError } from "@/components/ui/messages";
import type { ActionResult } from "@/types";
import type { CampaignStatus } from "@/types";

function LifecycleForm({
  campaignId,
  action,
  label,
  variant,
}: {
  campaignId: string;
  action: (
    prevState: ActionResult | null,
    formData: FormData,
  ) => Promise<ActionResult>;
  label: string;
  variant: "primary" | "accent" | "outline" | "danger";
}) {
  const [state, formAction, isPending] = useActionState<
    ActionResult | null,
    FormData
  >(action, null);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="campaignId" value={campaignId} />
      <button
        type="submit"
        disabled={isPending}
        className={buttonClasses({ variant, size: "sm", className: "w-full" })}
      >
        {isPending ? "Working…" : label}
      </button>
      <FormError message={state && !state.success ? state.error : null} />
    </form>
  );
}

/**
 * Lifecycle buttons for a campaign the signed-in advertiser owns. The actions
 * re-verify ownership and allowed transitions server-side; these disabled
 * states are for guidance only.
 */
export function CampaignLifecycleControls({
  campaignId,
  status,
}: {
  campaignId: string;
  status: CampaignStatus;
}) {
  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-ink">Manage campaign</h3>

      {status === "DRAFT" ? (
        <>
          <LifecycleForm
            campaignId={campaignId}
            action={publishCampaignAction}
            label="Publish campaign"
            variant="accent"
          />
          <Link
            href={`/dashboard/campaigns/${campaignId}/edit`}
            className={buttonClasses({
              variant: "outline",
              size: "sm",
              className: "w-full",
            })}
          >
            Edit draft
          </Link>
        </>
      ) : null}

      {status === "PUBLISHED" ? (
        <>
          <LifecycleForm
            campaignId={campaignId}
            action={closeApplicationsAction}
            label="Close applications"
            variant="outline"
          />
          <Link
            href={`/dashboard/campaigns/${campaignId}/edit`}
            className={buttonClasses({
              variant: "outline",
              size: "sm",
              className: "w-full",
            })}
          >
            Edit details
          </Link>
        </>
      ) : null}

      {status === "APPLICATIONS_CLOSED" ? (
        <>
          <LifecycleForm
            campaignId={campaignId}
            action={startCampaignAction}
            label="Mark as in progress"
            variant="accent"
          />
          <LifecycleForm
            campaignId={campaignId}
            action={cancelCampaignAction}
            label="Cancel campaign"
            variant="danger"
          />
        </>
      ) : null}

      {status === "IN_PROGRESS" ? (
        <>
          <LifecycleForm
            campaignId={campaignId}
            action={completeCampaignAction}
            label="Mark as completed"
            variant="outline"
          />
          <LifecycleForm
            campaignId={campaignId}
            action={cancelCampaignAction}
            label="Cancel campaign"
            variant="danger"
          />
        </>
      ) : null}

      {status === "COMPLETED" || status === "CANCELLED" ? (
        <p className="rounded-lg border border-line bg-surface-muted px-3.5 py-3 text-sm text-ink-soft">
          This campaign has ended. Its history stays available but it no longer
          accepts applications or changes.
        </p>
      ) : null}
    </div>
  );
}
