import "server-only";

import type { Prisma } from "@/generated/prisma/client";

import { requireRole } from "@/lib/authz";
import { isUniqueConstraintError } from "@/lib/prisma-errors";
import { prisma } from "@/lib/prisma";
import { getCreatorVerifiedViews } from "@/services/verified-views.service";
import type {
  ActionResult,
  CreatorDashboardStats,
  CreatorProfileCompletion,
  CreatorProfileSummary,
} from "@/types";
import type { CreatorProfileInput } from "@/validation/creator";

type CreatorProfileWithRelations = Prisma.CreatorProfileGetPayload<{
  include: {
    user: { select: { name: true; email: true } };
    _count: { select: { socialAccounts: true } };
  };
}>;

function toProfileSummary(
  profile: CreatorProfileWithRelations,
): CreatorProfileSummary {
  return {
    id: profile.id,
    userId: profile.userId,
    name: profile.user.name,
    email: profile.user.email,
    username: profile.username,
    bio: profile.bio,
    location: profile.location,
    state: profile.state,
    country: profile.country,
    category: profile.category,
    followerCount: profile.followerCount,
    profileImage: profile.profileImage,
    socialAccountCount: profile._count.socialAccounts,
  };
}

export async function getCreatorProfile(
  userId: string,
): Promise<CreatorProfileSummary | null> {
  const profile = await prisma.creatorProfile.findUnique({
    where: { userId },
    include: {
      user: { select: { name: true, email: true } },
      _count: { select: { socialAccounts: true } },
    },
  });

  return profile ? toProfileSummary(profile) : null;
}

/**
 * Resolve the signed-in creator. The role is taken from the server-side session
 * and the profile is looked up from the database — never from client input.
 */
export async function getViewerCreator(): Promise<{
  userId: string;
  profile: CreatorProfileSummary;
}> {
  const user = await requireRole("CREATOR");
  const profile = await getCreatorProfile(user.id);

  if (!profile) {
    // Signup always creates a creator profile, so this indicates a data issue.
    throw new Error(`Creator profile missing for user ${user.id}`);
  }

  return { userId: user.id, profile };
}

/**
 * Profile completion is derived from real stored fields only. Missing items are
 * returned so the dashboard can tell the creator exactly what to add.
 */
export function computeProfileCompletion(
  profile: CreatorProfileSummary,
): CreatorProfileCompletion {
  const checks: Array<{ label: string; done: boolean }> = [
    { label: "Profile photo", done: Boolean(profile.profileImage) },
    { label: "Display name", done: Boolean(profile.name) },
    { label: "Username", done: Boolean(profile.username) },
    { label: "Bio", done: Boolean(profile.bio) },
    { label: "Category", done: Boolean(profile.category) },
    { label: "Location", done: Boolean(profile.location) },
    { label: "State", done: Boolean(profile.state) },
    { label: "Country", done: Boolean(profile.country) },
    { label: "Follower count", done: profile.followerCount > 0 },
    { label: "Linked social account", done: profile.socialAccountCount > 0 },
  ];

  const done = checks.filter((check) => check.done).length;
  const missing = checks.filter((check) => !check.done).map((c) => c.label);

  return {
    percentage: Math.round((done / checks.length) * 100),
    missing,
  };
}

export async function updateCreatorProfile(
  userId: string,
  input: CreatorProfileInput,
): Promise<ActionResult> {
  try {
    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { name: input.displayName },
      }),
      prisma.creatorProfile.update({
        where: { userId },
        data: {
          username: input.username,
          bio: input.bio ?? null,
          location: input.location ?? null,
          state: input.state ?? null,
          country: input.country ?? null,
          category: input.category ?? null,
          followerCount: input.followerCount,
          profileImage: input.profileImage ?? null,
        },
      }),
    ]);

    return { success: true, data: undefined };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return {
        success: false,
        error: "That username is already taken.",
        fieldErrors: { username: ["That username is already taken."] },
      };
    }

    console.error("updateCreatorProfile failed", error);
    return { success: false, error: "Could not save your profile." };
  }
}

/**
 * Resolve just the signed-in creator's profile id. Used by actions that only
 * need to scope a write to the current creator.
 */
export async function requireViewerCreatorId(): Promise<string> {
  const user = await requireRole("CREATOR");
  const profile = await prisma.creatorProfile.findUnique({
    where: { userId: user.id },
    select: { id: true },
  });

  if (!profile) {
    throw new Error(`Creator profile missing for user ${user.id}`);
  }

  return profile.id;
}

export async function getCreatorDashboardStats(
  creatorId: string,
): Promise<CreatorDashboardStats> {
  const [availableCampaigns, totalApplications, pendingApplications, activeCampaigns] =
    await Promise.all([
      prisma.campaign.count({
        where: {
          status: "PUBLISHED",
          OR: [
            { applicationDeadline: null },
            { applicationDeadline: { gte: new Date() } },
          ],
        },
      }),
      prisma.campaignApplication.count({ where: { creatorId } }),
      prisma.campaignApplication.count({
        where: { creatorId, status: "PENDING" },
      }),
      prisma.campaignApplication.count({
        where: { creatorId, status: "ACCEPTED" },
      }),
    ]);

  return {
    availableCampaigns,
    totalApplications,
    pendingApplications,
    activeCampaigns,
  };
}

/**
 * Verified-view summary for the creator dashboard home (Stage 9C). Delegates
 * entirely to the Stage 9A accounting service — the same aggregation that
 * powers campaign totals — so the dashboard number can never diverge from
 * per-campaign numbers. Never reads client input; never invents metrics.
 */
export async function getCreatorVerifiedViewSummary(creatorId: string): Promise<{
  totalVerifiedViews: number;
  verifiedPostCount: number;
  submittedPostCount: number;
}> {
  const [totals, submittedPostCount] = await Promise.all([
    getCreatorVerifiedViews(creatorId),
    // Posts awaiting verification (submitted or mid-run) — display context
    // for the verified-views figure, never a substitute for it.
    prisma.campaignPost.count({
      where: { creatorId, status: { in: ["SUBMITTED", "VERIFYING"] } },
    }),
  ]);

  return {
    totalVerifiedViews: totals.totalVerifiedViews,
    verifiedPostCount: totals.verifiedPostCount,
    submittedPostCount,
  };
}
