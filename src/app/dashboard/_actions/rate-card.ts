"use server";

import { revalidatePath } from "next/cache";

import {
  createRateCardItem,
  toggleRateCardItem,
  updateRateCardItem,
} from "@/services/rate-card.service";
import { requireViewerCreatorId } from "@/services/creator.service";
import type { ActionResult } from "@/types";
import {
  createRateCardItemSchema,
  toggleRateCardItemSchema,
  updateRateCardItemSchema,
} from "@/validation/rate-card";
import { flattenFieldErrors } from "@/validation/errors";

export async function createRateCardItemAction(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  // Identity comes from the session, never from the submitted form.
  const creatorId = await requireViewerCreatorId();

  const parsed = createRateCardItemSchema.safeParse({
    platform: formData.get("platform"),
    serviceType: formData.get("serviceType"),
    price: formData.get("price"),
    currency: formData.get("currency") ?? "NGN",
    description: formData.get("description") ?? undefined,
  });

  if (!parsed.success) {
    return {
      success: false,
      error: "Please check the highlighted fields.",
      fieldErrors: flattenFieldErrors(parsed.error),
    };
  }

  const result = await createRateCardItem(creatorId, parsed.data);

  if (!result.success) {
    return result;
  }

  revalidatePath("/dashboard/rate-card");

  return { success: true, data: undefined };
}

export async function updateRateCardItemAction(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const creatorId = await requireViewerCreatorId();

  const parsed = updateRateCardItemSchema.safeParse({
    itemId: formData.get("itemId"),
    price: formData.get("price"),
    currency: formData.get("currency") ?? "NGN",
    description: formData.get("description") ?? undefined,
  });

  if (!parsed.success) {
    return {
      success: false,
      error: "Please check the highlighted fields.",
      fieldErrors: flattenFieldErrors(parsed.error),
    };
  }

  // History-preserving edit: the service deactivates the ACTIVE row
  // conditionally (ownership + status in the WHERE) and writes a new version.
  const result = await updateRateCardItem(creatorId, parsed.data);

  if (!result.success) {
    return result;
  }

  revalidatePath("/dashboard/rate-card");

  return { success: true, data: undefined };
}

export async function toggleRateCardItemAction(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const creatorId = await requireViewerCreatorId();

  const parsed = toggleRateCardItemSchema.safeParse({
    itemId: formData.get("itemId"),
  });

  if (!parsed.success) {
    return { success: false, error: "Invalid rate-card item." };
  }

  const result = await toggleRateCardItem(creatorId, parsed.data.itemId);

  if (!result.success) {
    return result;
  }

  revalidatePath("/dashboard/rate-card");

  return { success: true, data: undefined };
}
