import "server-only";

import type { Prisma } from "@/generated/prisma/client";

import { prisma } from "@/lib/prisma";
import type { CampaignDetail, CampaignSummary } from "@/types";
import type { CampaignFilters } from "@/validation/campaign";

type CampaignWithAdvertiser = Prisma.CampaignGetPayload<{
  include: {
    advertiser: { select: { companyName: true; location: true } };
  };
}>;

function toCampaignSummary(campaign: CampaignWithAdvertiser): CampaignSummary {
  return {
    id: campaign.id,
    title: campaign.title,
    description: campaign.description,
    platform: campaign.platform,
    category: campaign.category,
    targetLocation: campaign.targetLocation,
    budget: campaign.budget.toString(),
    currency: campaign.currency,
    minimumFollowers: campaign.minimumFollowers,
    status: campaign.status,
    applicationDeadline: campaign.applicationDeadline,
    startDate: campaign.startDate,
    endDate: campaign.endDate,
    tags: campaign.tags,
    maxCreators: campaign.maxCreators,
    advertiser: {
      companyName: campaign.advertiser.companyName,
      location: campaign.advertiser.location,
    },
  };
}

function sortToOrderBy(
  sort: CampaignFilters["sort"],
): Prisma.CampaignOrderByWithRelationInput {
  switch (sort) {
    // Stage 12: compensation is creator-quoted, so "highest rate" sorting is
    // retired; budget remains as a size signal.
    case "budget":
      return { budget: "desc" };
    case "deadline":
      return { applicationDeadline: "asc" };
    default:
      return { createdAt: "desc" };
  }
}

/**
 * Marketplace listing (Stage 12). Every filter is applied in the database
 * query rather than being filtered in the browser, and only PUBLISHED
 * campaigns that are still open for applications are returned. Drafts are
 * invisible to creators — status is fixed server-side, never a filter input.
 */
export async function listCampaigns(
  filters: CampaignFilters = {},
): Promise<CampaignSummary[]> {
  const now = new Date();

  const and: Prisma.CampaignWhereInput[] = [
    // Still open: either no deadline, or the deadline has not passed.
    { OR: [{ applicationDeadline: null }, { applicationDeadline: { gte: now } }] },
  ];

  if (filters.q) {
    and.push({
      OR: [
        { title: { contains: filters.q, mode: "insensitive" } },
        { description: { contains: filters.q, mode: "insensitive" } },
        { tags: { has: filters.q } },
        {
          advertiser: {
            companyName: { contains: filters.q, mode: "insensitive" },
          },
        },
      ],
    });
  }

  const campaigns = await prisma.campaign.findMany({
    where: {
      status: "PUBLISHED",
      platform: filters.platform,
      category: filters.category,
      targetLocation: filters.location
        ? { contains: filters.location, mode: "insensitive" }
        : undefined,
      // Budget must accommodate the creator's audience size.
      minimumFollowers: filters.minFollowers
        ? { lte: filters.minFollowers }
        : undefined,
      // Budget range filter — the CPM rate filter is retired (Stage 12).
      budget: filters.minBudget
        ? { gte: String(filters.minBudget) }
        : undefined,
      AND: and,
    },
    orderBy: sortToOrderBy(filters.sort),
    take: 60,
    include: {
      advertiser: { select: { companyName: true, location: true } },
    },
  });

  return campaigns.map(toCampaignSummary);
}

export async function getCampaignDetail(
  id: string,
): Promise<CampaignDetail | null> {
  const campaign = await prisma.campaign.findUnique({
    where: { id },
    include: {
      advertiser: {
        select: {
          companyName: true,
          companyDescription: true,
          location: true,
          website: true,
        },
      },
      _count: { select: { applications: true } },
    },
  });

  if (!campaign) {
    return null;
  }

  return {
    id: campaign.id,
    title: campaign.title,
    description: campaign.description,
    platform: campaign.platform,
    category: campaign.category,
    targetLocation: campaign.targetLocation,
    budget: campaign.budget.toString(),
    currency: campaign.currency,
    minimumFollowers: campaign.minimumFollowers,
    status: campaign.status,
    applicationDeadline: campaign.applicationDeadline,
    startDate: campaign.startDate,
    endDate: campaign.endDate,
    tags: campaign.tags,
    maxCreators: campaign.maxCreators,
    contentRequirements: campaign.contentRequirements,
    rules: campaign.rules,
    applicationCount: campaign._count.applications,
    advertiser: {
      companyName: campaign.advertiser.companyName,
      companyDescription: campaign.advertiser.companyDescription,
      location: campaign.advertiser.location,
      website: campaign.advertiser.website,
    },
  };
}

/** Count campaigns that are open for applications right now. */
export async function countOpenCampaigns(): Promise<number> {
  const now = new Date();

  return prisma.campaign.count({
    where: {
      status: "PUBLISHED",
      OR: [{ applicationDeadline: null }, { applicationDeadline: { gte: now } }],
    },
  });
}
