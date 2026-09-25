import "server-only";

import type { Prisma } from "@/generated/prisma/client";

import { prisma } from "@/lib/prisma";
import type {
  ActionResult,
  CampaignAgreementSummary,
} from "@/types";

/**
 * Stage 12 — campaign agreements (frozen accepted terms).
 *
 * An agreement row is created only inside the advertiser's acceptance
 * transaction (see reviewApplication in advertiser.service.ts) and is never
 * written from client input afterwards. The agreed quote and terms survive
 * any later campaign edit because nothing in this module reads the Campaign
 * row for money — it reads the frozen columns.
 *
 * Reads are strictly scoped: a creator sees agreements on their own accepted
 * participations; an advertiser sees agreements on their own campaigns.
 * Unrelated ids simply return null / empty lists.
 */

const agreementInclude = {
  campaign: {
    select: {
      id: true,
      title: true,
      status: true,
      contentRequirements: true,
    },
  },
  advertiser: { select: { companyName: true } },
  creator: {
    select: { user: { select: { name: true } }, username: true },
  },
} satisfies Prisma.CampaignAgreementInclude;

type AgreementRow = Prisma.CampaignAgreementGetPayload<{
  include: typeof agreementInclude;
}>;

function toAgreementSummary(row: AgreementRow): CampaignAgreementSummary {
  return {
    id: row.id,
    status: row.status,
    platform: row.platform,
    agreedAmount: row.agreedAmount.toString(),
    currency: row.currency,
    deliverables: row.deliverables,
    startDate: row.startDate,
    endDate: row.endDate,
    acceptedAt: row.acceptedAt,
    campaign: {
      id: row.campaign.id,
      title: row.campaign.title,
      status: row.campaign.status,
      contentRequirements: row.campaign.contentRequirements,
    },
    advertiser: { companyName: row.advertiser.companyName },
    creator: {
      name: row.creator.user.name,
      username: row.creator.username,
    },
  };
}

/** All agreements for campaigns owned by this advertiser. */
export async function listAdvertiserAgreements(
  advertiserId: string,
): Promise<CampaignAgreementSummary[]> {
  const agreements = await prisma.campaignAgreement.findMany({
    where: { advertiserId },
    orderBy: { acceptedAt: "desc" },
    include: agreementInclude,
  });

  return agreements.map(toAgreementSummary);
}

/**
 * One agreement by id, visible only to the owning advertiser. Foreign or
 * guessed ids return null — the ownership filter is inside the query.
 */
export async function getAdvertiserAgreement(
  advertiserId: string,
  agreementId: string,
): Promise<CampaignAgreementSummary | null> {
  const agreement = await prisma.campaignAgreement.findFirst({
    where: { id: agreementId, advertiserId },
    include: agreementInclude,
  });

  return agreement ? toAgreementSummary(agreement) : null;
}

/** All agreements for this creator's accepted participations. */
export async function listCreatorAgreements(
  creatorId: string,
): Promise<CampaignAgreementSummary[]> {
  const agreements = await prisma.campaignAgreement.findMany({
    where: { creatorId },
    orderBy: { acceptedAt: "desc" },
    include: agreementInclude,
  });

  return agreements.map(toAgreementSummary);
}

/**
 * One agreement by id, visible only to the creator whose accepted
 * application produced it.
 */
export async function getCreatorAgreement(
  creatorId: string,
  agreementId: string,
): Promise<CampaignAgreementSummary | null> {
  const agreement = await prisma.campaignAgreement.findFirst({
    where: { id: agreementId, creatorId },
    include: agreementInclude,
  });

  return agreement ? toAgreementSummary(agreement) : null;
}

/**
 * The agreement attached to a specific accepted application, if any — used by
 * campaign detail views to show the creator's guaranteed fee.
 */
export async function getAgreementForApplication(
  viewerCreatorId: string,
  applicationId: string,
): Promise<CampaignAgreementSummary | null> {
  const agreement = await prisma.campaignAgreement.findFirst({
    where: { applicationId, creatorId: viewerCreatorId },
    include: agreementInclude,
  });

  return agreement ? toAgreementSummary(agreement) : null;
}
