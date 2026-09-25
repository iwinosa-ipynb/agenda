import "server-only";

import type { Prisma } from "@/generated/prisma/client";

import { isUniqueConstraintError } from "@/lib/prisma-errors";
import { prisma } from "@/lib/prisma";
import { toMoneyString } from "@/lib/pricing-math";
import type {
  ActionResult,
  PublicRateCardItem,
  RateCardItemSummary,
} from "@/types";
import type {
  CreateRateCardItemInput,
  UpdateRateCardItemInput,
} from "@/validation/rate-card";

/**
 * Stage 12 — creator rate cards.
 *
 * What a rate-card item IS: the creator's own listed starting price for a
 * platform + content-type combination. The UI labels it "Creator's listed
 * rate". It is a REFERENCE for advertisers, never a market price — Agenda has
 * no historical marketplace pricing data at launch and never presents listed
 * rates as market evidence.
 *
 * What it is NOT (Stage 12 rules):
 *   - NOT a transaction. Completed-campaign prices live on
 *     CampaignAgreement.agreedAmount and are a different dataset.
 *   - NOT a source for application quotes. The creator types each campaign
 *     quote fresh; nothing is pre-filled from the rate card.
 *   - NOT mutable history. Editing an ACTIVE item deactivates it and writes a
 *     new ACTIVE row (version = previous + 1), preserving listed-rate history
 *     for future pricing intelligence. History is clearly LISTED-rate data —
 *     never treated as transaction data.
 *
 * All writes are ownership-scoped: creatorId comes from the session-resolved
 * profile, never from client input.
 */

type RateCardRow = Prisma.RateCardItemGetPayload<Record<string, never>>;

function toSummary(row: RateCardRow): RateCardItemSummary {
  return {
    id: row.id,
    platform: row.platform,
    serviceType: row.serviceType,
    price: row.price.toString(),
    currency: row.currency,
    description: row.description,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deactivatedAt: row.deactivatedAt,
  };
}

function toPublicSummary(row: RateCardRow): PublicRateCardItem {
  return {
    id: row.id,
    platform: row.platform,
    serviceType: row.serviceType,
    price: row.price.toString(),
    currency: row.currency,
    description: row.description,
    updatedAt: row.updatedAt,
  };
}

/** The creator's full rate card, active items first, then history. */
export async function listRateCardItems(
  creatorId: string,
): Promise<RateCardItemSummary[]> {
  const rows = await prisma.rateCardItem.findMany({
    where: { creatorId },
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
  });

  return rows.map(toSummary);
}

/** Active items only — the view the creator's public rate card shows. */
export async function listActiveRateCardItems(
  creatorId: string,
): Promise<RateCardItemSummary[]> {
  const rows = await prisma.rateCardItem.findMany({
    where: { creatorId, status: "ACTIVE" },
    orderBy: [{ platform: "asc" }, { updatedAt: "desc" }],
  });

  return rows.map(toSummary);
}

/**
 * Active rate-card items visible to advertisers. Public exposure is exactly
 * the active set: deactivated history and inactive rows are never shown.
 */
export async function listPublicRateCardItems(
  creatorId: string,
): Promise<PublicRateCardItem[]> {
  const rows = await prisma.rateCardItem.findMany({
    where: { creatorId, status: "ACTIVE" },
    orderBy: [{ platform: "asc" }, { updatedAt: "desc" }],
  });

  return rows.map(toPublicSummary);
}

/**
 * Create a listed-rate item. The (creatorId, platform, serviceType, ACTIVE)
 * unique constraint means there can be only one active listing per
 * combination — a duplicate lands on the edit path instead.
 */
export async function createRateCardItem(
  creatorId: string,
  input: CreateRateCardItemInput,
): Promise<ActionResult<{ itemId: string }>> {
  try {
    const item = await prisma.rateCardItem.create({
      data: {
        creatorId,
        platform: input.platform,
        serviceType: input.serviceType,
        price: toMoneyString(Number(input.price)),
        currency: input.currency,
        description: input.description ?? null,
        status: "ACTIVE",
        version: 1,
      },
      select: { id: true },
    });

    return { success: true, data: { itemId: item.id } };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return {
        success: false,
        error:
          "You already have an active rate for this platform and content type. Edit that one instead.",
        fieldErrors: {
          serviceType: [
            "You already have an active rate for this platform and content type. Edit that one instead.",
          ],
        },
      };
    }

    console.error("createRateCardItem failed", error);
    return { success: false, error: "Could not save your rate." };
  }
}

/**
 * Edit an active item WITHOUT overwriting history: the existing ACTIVE row is
 * deactivated (kept, deactivatedAt stamped) and a replacement ACTIVE row is
 * created inside one transaction with version = previous + 1. Price changes
 * therefore leave a queryable trail of the creator's listed rates.
 *
 * Only ACTIVE items are editable. Inactive rows are frozen history; the
 * creator reactivates them instead (which reactivates the frozen values).
 *
 * Concurrency: the deactivation is a conditional updateMany on the ACTIVE
 * row. Two simultaneous edits of the same item — one loses: after the first
 * transaction commits there is no ACTIVE row left to match, so the second
 * deactivation touches zero rows and the edit is refused.
 */
export async function updateRateCardItem(
  creatorId: string,
  input: UpdateRateCardItemInput,
): Promise<ActionResult<{ itemId: string }>> {
  try {
    const newItemId = await prisma.$transaction(async (tx) => {
      // Conditional deactivation: only the ACTIVE row owned by this creator
      // matches. Ownership is in the WHERE — a foreign itemId matches nothing.
      const deactivated = await tx.rateCardItem.updateMany({
        where: {
          id: input.itemId,
          creatorId,
          status: "ACTIVE",
        },
        data: { status: "INACTIVE", deactivatedAt: new Date() },
      });

      if (deactivated.count === 0) {
        return null;
      }

      // Read the just-deactivated row for its identity + version. The read is
      // safe inside the same transaction (row was locked by the update).
      const previous = await tx.rateCardItem.findFirst({
        where: { id: input.itemId, creatorId },
        select: {
          platform: true,
          serviceType: true,
          currency: true,
          version: true,
        },
      });

      if (!previous) {
        // Cannot actually happen (deactivation matched), but the transaction
        // must not write a half-state. Throwing rolls both writes back.
        throw new Error("rate card item vanished during update");
      }

      const created = await tx.rateCardItem.create({
        data: {
          creatorId,
          platform: previous.platform,
          serviceType: previous.serviceType,
          price: toMoneyString(Number(input.price)),
          currency: input.currency,
          description: input.description ?? null,
          status: "ACTIVE",
          version: previous.version + 1,
        },
        select: { id: true },
      });

      return created.id;
    });

    if (newItemId === null) {
      return {
        success: false,
        error:
          "That rate isn't active anymore. Refresh the page to see your current rate card.",
      };
    }

    return { success: true, data: { itemId: newItemId } };
  } catch (error) {
    console.error("updateRateCardItem failed", error);
    return { success: false, error: "Could not save your change." };
  }
}

/**
 * Deactivate an item. It stays in the table as history and can be
 * reactivated with its last values. Reactivating an INACTIVE row of a
 * combination that already has another ACTIVE listing is refused — the
 * constraint allows only one ACTIVE row per combination.
 */
export async function toggleRateCardItem(
  creatorId: string,
  itemId: string,
): Promise<ActionResult> {
  const item = await prisma.rateCardItem.findFirst({
    where: { id: itemId, creatorId },
    select: { id: true, status: true, platform: true, serviceType: true },
  });

  if (!item) {
    return { success: false, error: "Rate-card item not found." };
  }

  if (item.status === "ACTIVE") {
    const result = await prisma.rateCardItem.updateMany({
      where: { id: itemId, creatorId, status: "ACTIVE" },
      data: { status: "INACTIVE", deactivatedAt: new Date() },
    });

    if (result.count === 0) {
      return { success: false, error: "That rate has already changed." };
    }

    return { success: true, data: undefined };
  }

  // Reactivation path.
  const activeSibling = await prisma.rateCardItem.findFirst({
    where: {
      creatorId,
      platform: item.platform,
      serviceType: item.serviceType,
      status: "ACTIVE",
    },
    select: { id: true },
  });

  if (activeSibling) {
    return {
      success: false,
      error:
        "You already have an active rate for this platform and content type.",
    };
  }

  const result = await prisma.rateCardItem.updateMany({
    where: { id: itemId, creatorId, status: "INACTIVE" },
    data: { status: "ACTIVE", deactivatedAt: null },
  });

  if (result.count === 0) {
    return { success: false, error: "That rate has already changed." };
  }

  return { success: true, data: undefined };
}

/** Single item, ownership-scoped — used by the edit form's server checks. */
export async function getRateCardItem(
  creatorId: string,
  itemId: string,
): Promise<RateCardItemSummary | null> {
  const row = await prisma.rateCardItem.findFirst({
    where: { id: itemId, creatorId },
  });

  return row ? toSummary(row) : null;
}
