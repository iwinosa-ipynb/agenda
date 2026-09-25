import "server-only";

import type { Prisma } from "@/generated/prisma/client";

import { requireRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { toMoneyString } from "@/lib/pricing-math";
import type {
  ActionResult,
  AdvertiserApplicationSummary,
  AdvertiserCampaignDetail,
  AdvertiserCampaignSummary,
  AdvertiserDashboardStats,
  AdvertiserProfileCompletion,
  AdvertiserProfileSummary,
  CreatorReviewSummary,
} from "@/types";
import type {
  AdvertiserProfileInput,
  CampaignWriteInput,
} from "@/validation/advertiser";

type AdvertiserProfileWithUser = Prisma.AdvertiserProfileGetPayload<{
  include: { user: { select: { name: true; email: true } } };
}>;

function toProfileSummary(
  profile: AdvertiserProfileWithUser,
): AdvertiserProfileSummary {
  return {
    id: profile.id,
    userId: profile.userId,
    name: profile.user.name,
    email: profile.user.email,
    companyName: profile.companyName,
    companyDescription: profile.companyDescription,
    location: profile.location,
    state: profile.state,
    country: profile.country,
    website: profile.website,
    logoUrl: profile.logoUrl,
  };
}

export async function getAdvertiserProfile(
  userId: string,
): Promise<AdvertiserProfileSummary | null> {
  const profile = await prisma.advertiserProfile.findUnique({
    where: { userId },
    include: { user: { select: { name: true, email: true } } },
  });

  return profile ? toProfileSummary(profile) : null;
}

/**
 * Resolve the signed-in advertiser. Role comes from the server session and the
 * profile is looked up from the database — never from client input.
 */
export async function getViewerAdvertiser(): Promise<{
  userId: string;
  profile: AdvertiserProfileSummary;
}> {
  const user = await requireRole("ADVERTISER");
  const profile = await getAdvertiserProfile(user.id);

  if (!profile) {
    // Signup always creates an advertiser profile, so this indicates a data
    // issue rather than something the client can trigger.
    throw new Error(`Advertiser profile missing for user ${user.id}`);
  }

  return { userId: user.id, profile };
}

/** Profile completion derived from real stored fields only. */
export function computeAdvertiserProfileCompletion(
  profile: AdvertiserProfileSummary,
): AdvertiserProfileCompletion {
  const checks: Array<{ label: string; done: boolean }> = [
    { label: "Company logo", done: Boolean(profile.logoUrl) },
    { label: "Company name", done: profile.companyName.length >= 2 },
    { label: "Company description", done: Boolean(profile.companyDescription) },
    { label: "Location", done: Boolean(profile.location) },
    { label: "State", done: Boolean(profile.state) },
    { label: "Country", done: Boolean(profile.country) },
    { label: "Website", done: Boolean(profile.website) },
  ];

  const done = checks.filter((check) => check.done).length;

  return {
    percentage: Math.round((done / checks.length) * 100),
    missing: checks.filter((check) => !check.done).map((check) => check.label),
  };
}

export async function updateAdvertiserProfile(
  userId: string,
  input: AdvertiserProfileInput,
): Promise<ActionResult> {
  try {
    await prisma.advertiserProfile.update({
      where: { userId },
      data: {
        companyName: input.companyName,
        companyDescription: input.companyDescription ?? null,
        location: input.location ?? null,
        state: input.state ?? null,
        country: input.country ?? null,
        website: input.website ?? null,
        logoUrl: input.logoUrl ?? null,
      },
    });

    return { success: true, data: undefined };
  } catch (error) {
    console.error("updateAdvertiserProfile failed", error);
    return { success: false, error: "Could not save your profile." };
  }
}

/**
 * Resolve just the signed-in advertiser's profile id, for actions that only
 * need to scope a write to the current advertiser.
 */
export async function requireViewerAdvertiserId(): Promise<string> {
  const user = await requireRole("ADVERTISER");
  const profile = await prisma.advertiserProfile.findUnique({
    where: { userId: user.id },
    select: { id: true },
  });

  if (!profile) {
    throw new Error(`Advertiser profile missing for user ${user.id}`);
  }

  return profile.id;
}

// ---------------------------------------------------------------------------
// Dashboard stats
// ---------------------------------------------------------------------------

export async function getAdvertiserDashboardStats(
  advertiserId: string,
): Promise<AdvertiserDashboardStats> {
  const [totalCampaigns, activeCampaigns, pendingApplications, budgetAggregate] =
    await Promise.all([
      prisma.campaign.count({ where: { advertiserId } }),
      prisma.campaign.count({
        where: { advertiserId, status: "PUBLISHED" },
      }),
      prisma.campaignApplication.count({
        where: { campaign: { advertiserId }, status: "PENDING" },
      }),
      // Group by currency so budgets are never summed across currencies.
      prisma.campaign.groupBy({
        by: ["currency"],
        where: { advertiserId },
        _sum: { budget: true },
      }),
    ]);

  const primary = budgetAggregate[0];

  return {
    totalCampaigns,
    activeCampaigns,
    pendingApplications,
    totalBudget: {
      amount: primary?._sum.budget?.toString() ?? "0",
      currency: primary?.currency ?? "NGN",
    },
  };
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

const campaignSummarySelect = {
  id: true,
  title: true,
  platform: true,
  category: true,
  targetLocation: true,
  targetCountry: true,
  budget: true,
  currency: true,
  status: true,
  applicationDeadline: true,
  startDate: true,
  endDate: true,
  maxCreators: true,
  tags: true,
  createdAt: true,
  _count: { select: { applications: true } },
} satisfies Prisma.CampaignSelect;

type CampaignRow = Prisma.CampaignGetPayload<{
  select: typeof campaignSummarySelect;
}>;

function toCampaignSummary(row: CampaignRow): AdvertiserCampaignSummary {
  return {
    id: row.id,
    title: row.title,
    platform: row.platform,
    category: row.category,
    targetLocation: row.targetLocation,
    targetCountry: row.targetCountry,
    budget: row.budget.toString(),
    currency: row.currency,
    status: row.status,
    applicationDeadline: row.applicationDeadline,
    startDate: row.startDate,
    endDate: row.endDate,
    applicationCount: row._count.applications,
    maxCreators: row.maxCreators,
    tags: row.tags,
    createdAt: row.createdAt,
  };
}

/** Campaigns owned by this advertiser only — the where clause is server-side. */
export async function listAdvertiserCampaigns(
  advertiserId: string,
): Promise<AdvertiserCampaignSummary[]> {
  const campaigns = await prisma.campaign.findMany({
    where: { advertiserId },
    orderBy: { createdAt: "desc" },
    select: campaignSummarySelect,
  });

  return campaigns.map(toCampaignSummary);
}

export async function getAdvertiserCampaign(
  advertiserId: string,
  campaignId: string,
): Promise<AdvertiserCampaignDetail | null> {
  const campaign = await prisma.campaign.findFirst({
    // Ownership is part of the lookup itself: a guessed or foreign id simply
    // returns null instead of leaking another advertiser's campaign.
    where: { id: campaignId, advertiserId },
    select: {
      ...campaignSummarySelect,
      description: true,
      minimumFollowers: true,
      contentRequirements: true,
      rules: true,
    },
  });

  if (!campaign) {
    return null;
  }

  return {
    ...toCampaignSummary(campaign),
    description: campaign.description,
    minimumFollowers: campaign.minimumFollowers,
    contentRequirements: campaign.contentRequirements,
    rules: campaign.rules,
  };
}

/**
 * Load a campaign for editing, with the full field set the form needs.
 * Same ownership-in-the-query rule as above.
 */
export async function getAdvertiserCampaignForEdit(
  advertiserId: string,
  campaignId: string,
): Promise<AdvertiserCampaignDetail | null> {
  return getAdvertiserCampaign(advertiserId, campaignId);
}

export async function createCampaign(
  advertiserId: string,
  input: CampaignWriteInput,
  status: "DRAFT" | "PUBLISHED",
): Promise<ActionResult<{ campaignId: string }>> {
  try {
    const campaign = await prisma.campaign.create({
      data: {
        advertiserId,
        title: input.title,
        description: input.description,
        category: input.category,
        platform: input.platform,
        targetLocation: input.targetLocation,
        targetCountry: input.targetCountry ?? null,
        minimumFollowers: input.minimumFollowers,
        budget: toMoneyString(input.budget),
        // Retired CPM column: kept zero for new campaigns (see schema note).
        pricePerThousandViews: toMoneyString(0),
        currency: "NGN",
        startDate: input.startDate,
        endDate: input.endDate,
        applicationDeadline: input.applicationDeadline,
        contentRequirements: input.contentRequirements ?? null,
        rules: input.rules ?? null,
        maxCreators: input.maxCreators,
        tags: input.tags ?? [],
        status,
        ...(status === "PUBLISHED" ? { publishedAt: new Date() } : {}),
      },
      select: { id: true },
    });

    return { success: true, data: { campaignId: campaign.id } };
  } catch (error) {
    console.error("createCampaign failed", error);
    return { success: false, error: "Could not create the campaign." };
  }
}

/**
 * Update an owned campaign. The advertiserId filter is part of the update
 * where-clause, so ownership is enforced even if a foreign id is submitted.
 *
 * Stage 12 editing rules (brief §14):
 *   - DRAFT: fully editable.
 *   - PUBLISHED: limited editing — copy/requirements/dates may be refined, but
 *     the critical terms that creators applied against (budget, platform,
 *     category, maxCreators) cannot be silently changed.
 *   - Accepted agreements are never touched by campaign edits at all: their
 *     terms are frozen on the CampaignAgreement row at acceptance time.
 */
const PUBLISHED_EDITABLE_FIELDS = [
  "description",
  "contentRequirements",
  "rules",
  "applicationDeadline",
  "startDate",
  "endDate",
  "targetCountry",
  "tags",
] as const;

export async function updateCampaign(
  advertiserId: string,
  campaignId: string,
  input: CampaignWriteInput,
): Promise<ActionResult<{ campaignId: string }>> {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, advertiserId },
    select: { status: true },
  });

  if (!campaign) {
    return { success: false, error: "Campaign not found." };
  }

  // Published campaigns can only change non-critical terms. The critical
  // terms (platform, category, budget, maxCreators) are protected inside the
  // update's where-clause below: the write only proceeds when they still
  // match what the form loaded, and the data payload excludes them.
  const isDraft = campaign.status === "DRAFT";

  try {
    const result = await prisma.campaign.updateMany({
      where: {
        id: campaignId,
        advertiserId,
        // Optimistic critical-term check for published campaigns: if the
        // campaign changed since the form loaded, the update is refused.
        ...(isDraft
          ? {}
          : {
              platform: input.platform,
              category: input.category,
              budget: toMoneyString(input.budget),
              maxCreators: input.maxCreators,
            }),
      },
      data: isDraft
        ? {
            title: input.title,
            description: input.description,
            category: input.category,
            platform: input.platform,
            targetLocation: input.targetLocation,
            targetCountry: input.targetCountry ?? null,
            minimumFollowers: input.minimumFollowers,
            budget: toMoneyString(input.budget),
            startDate: input.startDate,
            endDate: input.endDate,
            applicationDeadline: input.applicationDeadline,
            contentRequirements: input.contentRequirements ?? null,
            rules: input.rules ?? null,
            maxCreators: input.maxCreators,
            tags: input.tags ?? [],
          }
        : {
            // Limited edit set for published campaigns.
            description: input.description,
            contentRequirements: input.contentRequirements ?? null,
            rules: input.rules ?? null,
            applicationDeadline: input.applicationDeadline,
            startDate: input.startDate,
            endDate: input.endDate,
            targetCountry: input.targetCountry ?? null,
            tags: input.tags ?? [],
          },
    });

    if (result.count === 0) {
      return {
        success: false,
        error: isDraft
          ? "Campaign not found."
          : "Critical campaign terms (platform, category, budget, creator slots) can't be changed after publishing. Other changes were not saved.",
      };
    }

    return { success: true, data: { campaignId } };
  } catch (error) {
    console.error("updateCampaign failed", error);
    return { success: false, error: "Could not save the campaign." };
  }
}

// ---------------------------------------------------------------------------
// Campaign lifecycle
// ---------------------------------------------------------------------------

/**
 * Requirements a campaign must meet before it can be published. Returns the
 * missing items so the advertiser sees exactly what to fix.
 */
export async function getCampaignPublishBlockers(
  advertiserId: string,
  campaignId: string,
): Promise<{ campaign: AdvertiserCampaignDetail } | { missing: string[] }> {
  const campaign = await getAdvertiserCampaign(advertiserId, campaignId);

  if (!campaign) {
    return { missing: ["Campaign not found."] };
  }

  const missing: string[] = [];

  if (campaign.title.trim().length < 3) {
    missing.push("Add a campaign title.");
  }
  if (campaign.description.trim().length < 20) {
    missing.push("Add a description of at least 20 characters.");
  }
  if (!(Number(campaign.budget) > 0)) {
    missing.push("Set a budget greater than zero.");
  }
  if (campaign.targetLocation.trim().length < 2) {
    missing.push("Add the location you're targeting.");
  }
  if (campaign.maxCreators < 1) {
    missing.push("Set how many creators can be accepted.");
  }
  if (
    campaign.startDate &&
    campaign.endDate &&
    campaign.startDate.getTime() > campaign.endDate.getTime()
  ) {
    missing.push("The start date must be on or before the end date.");
  }
  if (
    campaign.applicationDeadline &&
    campaign.endDate &&
    campaign.applicationDeadline.getTime() > campaign.endDate.getTime()
  ) {
    missing.push(
      "The application deadline must be on or before the campaign end date.",
    );
  }

  return missing.length > 0 ? { missing } : { campaign };
}

/** Lifecycle transitions allowed from each status (Stage 12 statuses). */
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["PUBLISHED"],
  PUBLISHED: ["APPLICATIONS_CLOSED", "CANCELLED"],
  APPLICATIONS_CLOSED: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

/**
 * Move a campaign through its lifecycle. Both the current status and the
 * ownership check happen inside the update where-clause, so the client can
 * never push a campaign into an invalid state or touch someone else's.
 */
export async function transitionCampaign(
  advertiserId: string,
  campaignId: string,
  action:
    | "PUBLISH"
    | "CLOSE_APPLICATIONS"
    | "START"
    | "COMPLETE"
    | "CANCEL",
): Promise<ActionResult> {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, advertiserId },
    select: { id: true, status: true },
  });

  if (!campaign) {
    return { success: false, error: "Campaign not found." };
  }

  const transitions: Record<
    typeof action,
    { next: string; invalidMessage?: string }
  > = {
    PUBLISH: {
      next: "PUBLISHED",
      invalidMessage:
        "Only draft campaigns can be published. Check that every required field is filled in.",
    },
    CLOSE_APPLICATIONS: {
      next: "APPLICATIONS_CLOSED",
      invalidMessage:
        "Only published campaigns can stop accepting applications.",
    },
    START: {
      next: "IN_PROGRESS",
      invalidMessage:
        "Applications must be closed before the campaign can start.",
    },
    COMPLETE: {
      next: "COMPLETED",
      invalidMessage: "Only in-progress campaigns can be completed.",
    },
    CANCEL: {
      next: "CANCELLED",
      invalidMessage: "Only unpublished or running campaigns can be cancelled.",
    },
  };

  const transition = transitions[action];

  if (!ALLOWED_TRANSITIONS[campaign.status]?.includes(transition.next)) {
    return {
      success: false,
      error:
        transition.invalidMessage ??
        "This campaign can't move to that status.",
    };
  }

  // Publishing re-checks completeness server-side: a draft that is missing
  // required fields must never reach the marketplace.
  if (action === "PUBLISH") {
    const publishCheck = await getCampaignPublishBlockers(
      advertiserId,
      campaignId,
    );

    if ("missing" in publishCheck) {
      return {
        success: false,
        error: `Before publishing: ${publishCheck.missing.join(" ")}`,
      };
    }
  }

  const result = await prisma.campaign.updateMany({
    where: {
      id: campaignId,
      advertiserId,
      status: campaign.status,
    },
    data: {
      status: transition.next as never,
      ...(transition.next === "PUBLISHED" ? { publishedAt: new Date() } : {}),
    },
  });

  if (result.count === 0) {
    return { success: false, error: "Campaign status already changed." };
  }

  return { success: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

const applicationInclude = {
  campaign: {
    select: {
      id: true,
      title: true,
      platform: true,
      status: true,
    },
  },
  creator: {
    // The display name lives on User, not on CreatorProfile.
    select: {
      id: true,
      username: true,
      location: true,
      category: true,
      followerCount: true,
      user: { select: { name: true } },
    },
  },
} satisfies Prisma.CampaignApplicationInclude;

type ApplicationRow = Prisma.CampaignApplicationGetPayload<{
  include: typeof applicationInclude;
}>;

function toApplicationSummary(
  application: ApplicationRow,
): AdvertiserApplicationSummary {
  return {
    id: application.id,
    status: application.status,
    message: application.message,
    // The creator's requested fee — the number the advertiser reviews.
    quoteAmount: application.quoteAmount,
    currency: application.currency,
    createdAt: application.createdAt,
    campaign: {
      id: application.campaign.id,
      title: application.campaign.title,
      platform: application.campaign.platform,
      status: application.campaign.status,
    },
    creator: {
      // The creator profile id is what review links need, not the user id.
      profileId: application.creator.id,
      name: application.creator.user.name,
      username: application.creator.username,
      location: application.creator.location,
      category: application.creator.category,
      followerCount: application.creator.followerCount,
    },
  };
}

/**
 * Applications submitted to campaigns owned by this advertiser. The ownership
 * chain (application → campaign → advertiser) is filtered in the query.
 */
export async function listAdvertiserApplications(
  advertiserId: string,
  filter: "PENDING" | "ALL" = "PENDING",
): Promise<AdvertiserApplicationSummary[]> {
  const applications = await prisma.campaignApplication.findMany({
    where: {
      campaign: { advertiserId },
      ...(filter === "PENDING" ? { status: "PENDING" as const } : {}),
    },
    orderBy: { createdAt: "asc" },
    include: applicationInclude,
  });

  return applications.map(toApplicationSummary);
}

export async function getAdvertiserApplication(
  advertiserId: string,
  applicationId: string,
): Promise<AdvertiserApplicationSummary | null> {
  const application = await prisma.campaignApplication.findFirst({
    where: { id: applicationId, campaign: { advertiserId } },
    include: applicationInclude,
  });

  return application ? toApplicationSummary(application) : null;
}

/**
 * Accept or reject an application, creating the frozen-terms agreement on
 * acceptance (Stage 12).
 *
 * Concurrency safety: the application row is flipped PENDING → ACCEPTED with
 * a conditional UPDATE inside a transaction; the agreement INSERT carries a
 * unique constraint on (campaignId, creatorId, status) and applicationId.
 * Two simultaneous accepts: only one UPDATE matches, the loser sees count=0.
 * Acceptance is additionally blocked when the campaign's creator slots are
 * full or the accepted quotes would exceed the remaining budget.
 */
export async function reviewApplication(
  advertiserId: string,
  applicationId: string,
  decision: "ACCEPT" | "REJECT",
): Promise<ActionResult> {
  const application = await prisma.campaignApplication.findFirst({
    where: { id: applicationId, campaign: { advertiserId } },
    select: {
      id: true,
      status: true,
      campaignId: true,
      creatorId: true,
      quoteAmount: true,
      currency: true,
      campaign: {
        select: {
          id: true,
          status: true,
          maxCreators: true,
          budget: true,
          platform: true,
          startDate: true,
          endDate: true,
          contentRequirements: true,
          applicationDeadline: true,
        },
      },
    },
  });

  if (!application) {
    return { success: false, error: "Application not found." };
  }

  if (application.status !== "PENDING") {
    return {
      success: false,
      error: "Only pending applications can be reviewed.",
    };
  }

  // Applications to closed/cancelled/completed campaigns can no longer be
  // accepted (rejection is always possible).
  if (
    decision === "ACCEPT" &&
    application.campaign.status !== "PUBLISHED" &&
    application.campaign.status !== "APPLICATIONS_CLOSED"
  ) {
    return {
      success: false,
      error: "This campaign is no longer accepting creators.",
    };
  }

  if (decision === "REJECT") {
    const result = await prisma.campaignApplication.updateMany({
      where: {
        id: applicationId,
        campaign: { advertiserId },
        status: "PENDING",
      },
      data: { status: "REJECTED" },
    });

    if (result.count === 0) {
      return {
        success: false,
        error: "This application has already been reviewed.",
      };
    }

    return { success: true, data: undefined };
  }

  // --- ACCEPT path: slot + budget guardrails, then transactional accept. ---

  const accepted = await prisma.campaignAgreement.findMany({
    where: { campaignId: application.campaignId, status: "ACTIVE" },
    select: { agreedAmount: true, currency: true },
  });

  if (accepted.length >= application.campaign.maxCreators) {
    return {
      success: false,
      error:
        "All creator slots for this campaign are already filled. Increase the number of creators or decline this application.",
    };
  }

  const committed = accepted.reduce(
    (sum, agreement) => sum + Number(agreement.agreedAmount.toString()),
    0,
  );

  const campaignBudget = Number(application.campaign.budget.toString());

  if (
    accepted.every((agreement) => agreement.currency === application.currency) &&
    committed + Number(application.quoteAmount) > campaignBudget
  ) {
    return {
      success: false,
      error:
        "Accepting this quote would exceed the campaign budget. Raise the budget on the campaign (draft) or decline this application.",
    };
  }

  const now = new Date();

  try {
    await prisma.$transaction(async (tx) => {
      // 1. Conditional flip: the database is the concurrency arbiter. If two
      // requests accept the same application, exactly one UPDATE matches.
      const flip = await tx.campaignApplication.updateMany({
        where: {
          id: applicationId,
          campaign: { advertiserId },
          status: "PENDING",
        },
        data: { status: "ACCEPTED" },
      });

      if (flip.count === 0) {
        throw new ReviewRaceError();
      }

      // 2. Freeze the agreed terms at acceptance time. The agreement INSERT
      // is covered by unique constraints — a race that slips past step 1
      // (two different applications, same campaign/creator) still cannot
      // produce two active agreements.
      await tx.campaignAgreement.create({
        data: {
          campaignId: application.campaignId,
          applicationId: application.id,
          advertiserId,
          creatorId: application.creatorId,
          status: "ACTIVE",
          platform: application.campaign.platform,
          agreedAmount: application.quoteAmount,
          currency: application.currency,
          deliverables: application.campaign.contentRequirements,
          startDate: application.campaign.startDate,
          endDate: application.campaign.endDate,
          acceptedAt: now,
        },
      });
    });
  } catch (error) {
    if (error instanceof ReviewRaceError) {
      return {
        success: false,
        error: "This application has already been reviewed.",
      };
    }

    console.error("reviewApplication accept failed", error);
    return {
      success: false,
      error: "Could not accept the application. Please try again.",
    };
  }

  return { success: true, data: undefined };
}

/** Internal signal for the lost acceptance race (not exposed to clients). */
class ReviewRaceError extends Error {
  constructor() {
    super("application review race lost");
    this.name = "ReviewRaceError";
  }
}

// ---------------------------------------------------------------------------
// Creator review
// ---------------------------------------------------------------------------

/**
 * Load a creator's profile for advertiser review. The campaignId is required
 * so access is always justified by a real application to one of this
 * advertiser's own campaigns — the advertiser cannot browse arbitrary
 * creators by guessing profile ids.
 */
export async function getCreatorForReview(
  advertiserId: string,
  applicationId: string,
): Promise<{
  application: AdvertiserApplicationSummary;
  creator: CreatorReviewSummary;
} | null> {
  const application = await prisma.campaignApplication.findFirst({
    where: { id: applicationId, campaign: { advertiserId } },
    include: {
      ...applicationInclude,
      creator: {
        select: {
          id: true,
          username: true,
          bio: true,
          location: true,
          state: true,
          country: true,
          category: true,
          followerCount: true,
          profileImage: true,
          user: { select: { name: true } },
          socialAccounts: {
            select: {
              id: true,
              platform: true,
              username: true,
              profileUrl: true,
              followerCount: true,
              status: true,
            },
          },
          // Stage 12: the creator's ACTIVE listed rates only. Inactive rows
          // are private history and are never exposed to advertisers.
          rateCardItems: {
            where: { status: "ACTIVE" },
            select: {
              id: true,
              platform: true,
              serviceType: true,
              price: true,
              currency: true,
              description: true,
              updatedAt: true,
            },
          },
        },
      },
    },
  });

  if (!application) {
    return null;
  }

  const creator = application.creator;

  return {
    application: toApplicationSummary(application),
    creator: {
      profileId: creator.id,
      name: creator.user.name,
      username: creator.username,
      bio: creator.bio,
      location: creator.location,
      state: creator.state,
      country: creator.country,
      category: creator.category,
      followerCount: creator.followerCount,
      profileImage: creator.profileImage,
      socialAccounts: creator.socialAccounts.map((account) => ({
        id: account.id,
        platform: account.platform,
        username: account.username,
        profileUrl: account.profileUrl,
        followerCount: account.followerCount,
        status: account.status,
      })),
      rateCard: creator.rateCardItems.map((item) => ({
        id: item.id,
        platform: item.platform,
        serviceType: item.serviceType,
        price: item.price.toString(),
        currency: item.currency,
        description: item.description,
        updatedAt: item.updatedAt,
      })),
    },
  };
}
