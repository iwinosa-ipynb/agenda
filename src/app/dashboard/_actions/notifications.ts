"use server";

import { revalidatePath } from "next/cache";

import { requireViewerCreatorId } from "@/services/creator.service";
import type { ActionResult } from "@/types";
import {
  countCreatorUnreadOpportunities,
  listCreatorOpportunities,
  markCreatorOpportunityRead,
} from "@/services/notifications.service";

/**
 * Creator Opportunity Notifications — creator-side actions.
 *
 * Identity is resolved ONLY from the server session (requireViewerCreatorId):
 * no form field can name a creator, so no client can create, read, or mark
 * another creator's notifications. Opportunity creation itself has NO action
 * at all — it happens exclusively inside the publication flow
 * (services/notifications.service.ts), which is what makes client-supplied
 * creator ids structurally impossible here.
 */

export async function listCreatorOpportunitiesAction(): Promise<
  Awaited<ReturnType<typeof listCreatorOpportunities>>
> {
  const creatorId = await requireViewerCreatorId();

  return listCreatorOpportunities(creatorId);
}

export async function countCreatorUnreadOpportunitiesAction(): Promise<number> {
  const creatorId = await requireViewerCreatorId();

  return countCreatorUnreadOpportunities(creatorId);
}

export async function markOpportunityReadAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const creatorId = await requireViewerCreatorId();

  const notificationId = formData.get("notificationId");

  if (typeof notificationId !== "string" || notificationId.trim() === "") {
    return { success: false, error: "Invalid notification." };
  }

  // Ownership rides inside the service's update where-clause: a guessed
  // foreign id matches nothing and reports failure without leaking.
  const updated = await markCreatorOpportunityRead(creatorId, notificationId);

  if (!updated) {
    return { success: false, error: "Notification not found." };
  }

  revalidatePath("/dashboard/opportunities");

  return { success: true, data: undefined };
}
