import type {
  AdvertiserProfile,
  AgreementStatus,
  ApplicationStatus,
  CampaignStatus,
  Category,
  CreatorProfile,
  Platform,
  PostStatus,
  SocialAccountStatus,
  User,
} from "@/generated/prisma/client";

// Re-export generated Prisma enums/types so application code imports from a
// single, stable location instead of reaching into the generated client.
export type {
  AdvertiserProfile,
  AgreementStatus,
  ApplicationStatus,
  Campaign,
  CampaignApplication,
  CampaignPost,
  CampaignStatus,
  Category,
  CreatorProfile,
  Platform,
  PostStatus,
  SocialAccount,
  SocialAccountStatus,
  User,
  UserRole,
} from "@/generated/prisma/client";

export type { User as AuthUser } from "@/generated/prisma/client";

/** A user together with the profile that matches their role. */
export type UserWithProfile = User & {
  creatorProfile: CreatorProfile | null;
  advertiserProfile: AdvertiserProfile | null;
};

/**
 * Public-facing campaign shape returned by the campaigns service. Money is
 * serialized to strings so it survives the server/client boundary without
 * depending on the Prisma Decimal runtime type.
 */
export type CampaignSummary = {
  id: string;
  title: string;
  description: string;
  platform: Platform;
  category: Category;
  targetLocation: string;
  budget: string;
  currency: string;
  minimumFollowers: number;
  status: CampaignStatus;
  applicationDeadline: Date | null;
  startDate: Date | null;
  endDate: Date | null;
  tags: string[];
  maxCreators: number;
  advertiser: {
    companyName: string;
    location: string | null;
  };
};

/** Full campaign read model used by the campaign detail page. */
export type CampaignDetail = Omit<CampaignSummary, "advertiser"> & {
  contentRequirements: string | null;
  rules: string | null;
  applicationCount: number;
  advertiser: {
    companyName: string;
    companyDescription: string | null;
    location: string | null;
    website: string | null;
  };
};

/** Creator profile as consumed by the dashboard/profile UI. */
export type CreatorProfileSummary = {
  id: string;
  userId: string;
  name: string;
  email: string;
  username: string;
  bio: string | null;
  location: string | null;
  state: string | null;
  country: string | null;
  category: Category | null;
  followerCount: number;
  profileImage: string | null;
  socialAccountCount: number;
};

export type CreatorProfileCompletion = {
  percentage: number;
  missing: string[];
};

export type CreatorDashboardStats = {
  availableCampaigns: number;
  totalApplications: number;
  pendingApplications: number;
  activeCampaigns: number;
};

export type SocialAccountSummary = {
  id: string;
  platform: Platform;
  username: string;
  profileUrl: string;
  followerCount: number | null;
  status: SocialAccountStatus;
  platformUserId: string | null;
  createdAt: Date;
};

export type ApplicationSummary = {
  id: string;
  status: ApplicationStatus;
  message: string | null;
  /** The creator's requested fee — creator-controlled, server-validated. */
  quoteAmount: string;
  currency: string;
  createdAt: Date;
  campaign: {
    id: string;
    title: string;
    platform: Platform;
    category: Category;
    status: CampaignStatus;
    applicationDeadline: Date | null;
    currency: string;
  };
  advertiser: {
    companyName: string;
  };
};

/** A campaign the creator has been accepted into. */
export type ActiveCampaignSummary = {
  applicationId: string;
  /** The agreed (guaranteed) fee from the accepted application. */
  agreedQuote: string;
  currency: string;
  campaign: {
    id: string;
    title: string;
    platform: Platform;
    status: CampaignStatus;
    startDate: Date | null;
    endDate: Date | null;
    contentRequirements: string | null;
    currency: string;
  };
  advertiser: {
    companyName: string;
  };
};

/**
 * A campaign as seen by its owning advertiser, including lifecycle counters.
 * Money stays string-serialized for the server/client boundary.
 */
export type AdvertiserCampaignSummary = {
  id: string;
  title: string;
  platform: Platform;
  category: Category;
  targetLocation: string;
  targetCountry: string | null;
  budget: string;
  currency: string;
  status: CampaignStatus;
  applicationDeadline: Date | null;
  startDate: Date | null;
  endDate: Date | null;
  applicationCount: number;
  maxCreators: number;
  tags: string[];
  createdAt: Date;
};

/** Everything the advertiser campaign detail page needs, including rules. */
export type AdvertiserCampaignDetail = Omit<
  AdvertiserCampaignSummary,
  "createdAt"
> & {
  description: string;
  minimumFollowers: number;
  contentRequirements: string | null;
  rules: string | null;
};

/** Advertiser profile as consumed by the dashboard/profile UI. */
export type AdvertiserProfileSummary = {
  id: string;
  userId: string;
  name: string;
  email: string;
  companyName: string;
  companyDescription: string | null;
  location: string | null;
  state: string | null;
  country: string | null;
  website: string | null;
  logoUrl: string | null;
};

export type AdvertiserProfileCompletion = {
  percentage: number;
  missing: string[];
};

export type AdvertiserDashboardStats = {
  totalCampaigns: number;
  activeCampaigns: number;
  pendingApplications: number;
  totalBudget: { amount: string; currency: string };
};

/** An application awaiting review by the campaign's owning advertiser. */
export type AdvertiserApplicationSummary = {
  id: string;
  status: ApplicationStatus;
  message: string | null;
  /** The creator's requested fee — shown to the advertiser for review. */
  quoteAmount: string;
  currency: string;
  createdAt: Date;
  campaign: {
    id: string;
    title: string;
    platform: Platform;
    status: CampaignStatus;
  };
  creator: {
    profileId: string;
    name: string;
    username: string;
    location: string | null;
    category: Category | null;
    // Self-reported by the creator; never treated as verified.
    followerCount: number;
  };
};

/**
 * Creator details for the advertiser's review view. Follower counts are
 * self-reported and must always be labelled as such until platform APIs land.
 */
export type CreatorReviewSummary = {
  profileId: string;
  name: string;
  username: string;
  bio: string | null;
  location: string | null;
  state: string | null;
  country: string | null;
  category: Category | null;
  followerCount: number;
  profileImage: string | null;
  socialAccounts: Array<{
    id: string;
    platform: Platform;
    username: string;
    profileUrl: string;
    followerCount: number | null;
    status: SocialAccountStatus;
  }>;
  /**
   * The creator's active listed rates (Stage 12). Reference only — the
   * application quote is the creator's actual offer for this campaign.
   */
  rateCard: PublicRateCardItem[];
};

/**
 * A submitted creator post as seen by the owning advertiser. Metrics are raw
 * values recorded for the post; verified views come exclusively from the
 * platform verification layer and are always server-computed.
 */
export type AdvertiserPostSummary = {
  id: string;
  platform: Platform;
  postUrl: string;
  caption: string | null;
  status: PostStatus;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  verifiedViews: number;
  /** Set only when a real verification sync has run for this post. */
  lastSyncedAt: Date | null;
  createdAt: Date;
  campaign: {
    id: string;
    title: string;
    status: CampaignStatus;
  };
  creator: {
    name: string;
    username: string;
  };
  /**
   * Neutral integrity presentation for the latest verified observation:
   * CLEAN → normal display; REVIEW → "additional verification required"
   * language. Never exposes accusations or internal check ids.
   */
  integrity: "CLEAN" | "REVIEW";
};

/**
 * Server-computed verified-view totals for one campaign (Stage 9). Every
 * value is derived from eligible verified posts — never accepted from a
 * client, never a sum of repeated cumulative snapshots.
 */
export type CampaignVerifiedViewsSummary = {
  totalVerifiedViews: number;
  eligiblePostCount: number;
  verifiedPostCount: number;
  hasReviewFlag: boolean;
};

/**
 * The frozen terms of an accepted application (Stage 12). The agreed quote
 * and terms come from the moment of acceptance and never change when the
 * campaign is edited later — eventual escrow/settlement reads this record.
 */
export type CampaignAgreementSummary = {
  id: string;
  status: AgreementStatus;
  platform: Platform;
  agreedAmount: string;
  currency: string;
  deliverables: string | null;
  startDate: Date | null;
  endDate: Date | null;
  acceptedAt: Date;
  campaign: {
    id: string;
    title: string;
    status: CampaignStatus;
    contentRequirements: string | null;
  };
  advertiser: { companyName: string };
  creator: { name: string; username: string };
};

/**
 * The creator's own listed rate-card item (Stage 12). "Creator's listed rate"
 * everywhere in the UI — never presented as a market price. Price is a
 * fixed-point string for safe server/client serialization.
 */
export type RateCardItemSummary = {
  id: string;
  platform: Platform;
  serviceType: string;
  price: string;
  currency: string;
  description: string | null;
  status: "ACTIVE" | "INACTIVE";
  /** Bumped on every structural edit; deactivation keeps the version. */
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deactivatedAt: Date | null;
};

/**
 * The subset of an active rate-card item shown to advertisers. Description is
 * creator-authored marketing copy, not verified platform data.
 */
export type PublicRateCardItem = {
  id: string;
  platform: Platform;
  serviceType: string;
  price: string;
  currency: string;
  description: string | null;
  updatedAt: Date;
};

/** Shape returned by any server action / route handler. */
export type ActionResult<T = undefined> =
  | { success: true; data: T }
  | { success: false; error: string; fieldErrors?: Record<string, string[]> };
