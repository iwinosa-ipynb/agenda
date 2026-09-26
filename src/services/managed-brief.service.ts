import "server-only";

import type { Prisma } from "@/generated/prisma/client";

import { getSupportActor } from "@/lib/authz";
import { isSupportedCurrency, toMinorUnits } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import type { ManagedBriefDetail, ManagedBriefSummary } from "@/types";
import type { ManagedBriefWriteInput } from "@/validation/managed-brief";

// ---------------------------------------------------------------------------
// Agenda Managed (V1, slice 1) — private managed-marketing briefs.
//
// Authorization model (fail closed on every path):
//   - Identity NEVER comes from client input. The owning advertiser is
//     resolved from the server session (role ADVERTISER + their
//     AdvertiserProfile), and the advertiserId is part of every read's
//     where-clause — a guessed or foreign id returns null, never data.
//   - Support reads go through the Stage 14D trusted-operator seam
//     (getSupportActor: SUPPORT role + fresh roster re-read from the DB).
//   - Everyone else — other advertisers, creators, anonymous callers — gets
//     nothing. There is no public read of a managed brief anywhere.
//
// Money discipline: the form carries a major-unit decimal string; this
// service converts it ONCE to exact BigInt minor units via toMinorUnits (the
// same boundary the financial layer uses). No client value ever writes a
// minor-unit column directly, and no financial object is derived from the
// brief in this slice — the budget is informational until a later stage.
// ---------------------------------------------------------------------------

const briefSummarySelect = {
  id: true,
  campaignGoal: true,
  budgetMinor: true,
  currency: true,
  targetAudience: true,
  targetPlatforms: true,
  status: true,
  createdAt: true,
} satisfies Prisma.ManagedBriefSelect;

type BriefSummaryRow = Prisma.ManagedBriefGetPayload<{
  select: typeof briefSummarySelect;
}>;

function toBriefSummary(row: BriefSummaryRow): ManagedBriefSummary {
  // BigInt does not cross the server/client boundary — serialize once here.
  return {
    id: row.id,
    campaignGoal: row.campaignGoal,
    budgetMinor: row.budgetMinor.toString(),
    currency: row.currency,
    targetAudience: row.targetAudience,
    targetPlatforms: [...row.targetPlatforms],
    status: row.status,
    createdAt: row.createdAt,
  };
}

const briefDetailSelect = {
  ...briefSummarySelect,
  description: true,
  creatorRequirements: true,
  updatedAt: true,
} satisfies Prisma.ManagedBriefSelect;

type BriefDetailRow = Prisma.ManagedBriefGetPayload<{
  select: typeof briefDetailSelect;
}>;

function toBriefDetail(row: BriefDetailRow): ManagedBriefDetail {
  return {
    ...toBriefSummary(row),
    description: row.description,
    creatorRequirements: row.creatorRequirements,
    updatedAt: row.updatedAt,
  };
}

/**
 * Create a brief for the given advertiser (resolved from the session by the
 * caller — see getViewerAdvertiser). Status is server-owned: every new brief
// starts as SUBMITTED and nothing in this slice can move it.
 */
export async function createManagedBrief(
  advertiserId: string,
  input: ManagedBriefWriteInput,
): Promise<{ success: true; data: { briefId: string } } | { success: false; error: string }> {
  if (!isSupportedCurrency(input.currency)) {
    return { success: false, error: "Choose a supported currency." };
  }

  // The single money boundary: validated major-unit number → fixed-point
  // string → exact BigInt minor units. No client value ever writes this
  // column directly.
  let budgetMinor: bigint;

  try {
    budgetMinor = toMinorUnits(input.budget.toFixed(2), input.currency);
  } catch {
    return { success: false, error: "Enter a valid budget." };
  }

  if (budgetMinor <= 0n) {
    return { success: false, error: "Budget must be greater than zero." };
  }

  try {
    const brief = await prisma.managedBrief.create({
      data: {
        advertiserId,
        campaignGoal: input.campaignGoal,
        description: input.description,
        budgetMinor,
        currency: input.currency,
        targetAudience: input.targetAudience,
        targetPlatforms: [...input.targetPlatforms],
        creatorRequirements: input.creatorRequirements ?? null,
        status: "SUBMITTED",
      },
      select: { id: true },
    });

    return { success: true, data: { briefId: brief.id } };
  } catch (error) {
    console.error("createManagedBrief failed", error);
    return { success: false, error: "Could not submit your brief. Please try again." };
  }
}

/**
 * The owning advertiser's briefs only — the where-clause is the access rule.
 */
export async function listManagedBriefs(
  advertiserId: string,
): Promise<ManagedBriefSummary[]> {
  const rows = await prisma.managedBrief.findMany({
    where: { advertiserId },
    orderBy: { createdAt: "desc" },
    select: briefSummarySelect,
  });

  return rows.map(toBriefSummary);
}

/**
 * Get one brief for its OWNER. Ownership is part of the lookup itself: a
 * foreign or guessed id returns null instead of leaking another advertiser's
 * brief. Support must use getManagedBriefForSupport — this function never
 * widens to other roles.
 */
export async function getManagedBrief(
  advertiserId: string,
  briefId: string,
): Promise<ManagedBriefDetail | null> {
  const row = await prisma.managedBrief.findFirst({
    // Ownership in the query: the database, not a post-check, decides.
    where: { id: briefId, advertiserId },
    select: briefDetailSelect,
  });

  return row ? toBriefDetail(row) : null;
}

/**
 * Get one brief for SUPPORT via the Stage 14D seam. The roster check is
 * re-read fresh from the database on every call, so a roster revocation ends
 * access immediately. Any other role (including ADVERTISER/CREATOR) resolves
 * to null here — support access never bypasses a user's own scoping, it only
 * adds an internal operator read.
 */
export async function getManagedBriefForSupport(
  briefId: string,
): Promise<ManagedBriefDetail | null> {
  const actor = await getSupportActor();

  if (!actor) {
    return null;
  }

  const row = await prisma.managedBrief.findFirst({
    where: { id: briefId },
    select: briefDetailSelect,
  });

  return row ? toBriefDetail(row) : null;
}
