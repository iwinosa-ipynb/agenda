import type {
  AdvertiserProfile,
  AgreementStatus,
  ApplicationStatus,
  CampaignStatus,
  Category,
  CreatorProfile,
  ManagedBriefCandidateStatus,
  ManagedBriefOutreachStatus,
  ManagedBriefStatus,
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
  ManagedBrief,
  ManagedBriefCandidateStatus,
  ManagedBriefOutreachStatus,
  ManagedBriefStatus,
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

// ---------------------------------------------------------------------------
// Agenda Managed (V1) — private managed-marketing briefs
// ---------------------------------------------------------------------------

/** A managed brief as seen by its owning advertiser (list rows). */
export type ManagedBriefSummary = {
  id: string;
  campaignGoal: string;
  budgetMinor: string;
  currency: string;
  targetAudience: string;
  targetPlatforms: string[];
  status: ManagedBriefStatus;
  createdAt: Date;
};

/** The full brief read model for the detail view (owner or support). */
export type ManagedBriefDetail = ManagedBriefSummary & {
  description: string;
  creatorRequirements: string | null;
  updatedAt: Date;
  // Support-review audit facts (slice 2). Null until a transition runs. The
  // owner's read model carries the timestamps but never the operator ids —
  // attribution is internal (see ManagedBriefSupportDetail).
  reviewStartedAt: Date | null;
  closedAt: Date | null;
};

/**
 * The brief detail as seen by a rostered Support operator (slice 2): the
 * owner's detail plus the operator attribution ids for each review
 * transition. The ids are internal — they never appear on any
 * advertiser-facing read model.
 */
export type ManagedBriefSupportDetail = ManagedBriefDetail & {
  reviewStartedById: string | null;
  closedById: string | null;
};

/**
 * A managed brief as seen by a rostered Support operator in the review queue
 * (slice 2). The operator id is included for attribution display — it is
 * always resolved from the server session behind the Stage 14D seam, never
 * from client input.
 */
export type ManagedBriefSupportSummary = ManagedBriefSummary & {
  advertiserCompanyName: string;
  reviewStartedAt: Date | null;
  closedAt: Date | null;
  reviewStartedById: string | null;
  closedById: string | null;
};

/** One sourcing candidate as displayed in the Support workspace (slice 3). */
export type ManagedBriefCandidateSummary = {
  id: string;
  status: ManagedBriefCandidateStatus;
  // Internal, support-eyes-only. Never rendered on any advertiser- or
  // creator-facing read model.
  note: string | null;
  addedById: string;
  statusUpdatedAt: Date | null;
  statusUpdatedById: string | null;
  createdAt: Date;
  updatedAt: Date;
  // Referenced identity — always resolved from the live CreatorProfile /
  // SocialAccount rows, never duplicated into the candidate record.
  creator: {
    profileId: string;
    name: string;
    username: string;
    category: Category | null;
    // Self-reported by the creator; labelled as such in the UI.
    followerCount: number;
  };
  account: {
    accountId: string;
    platform: Platform;
    username: string;
    profileUrl: string;
    status: SocialAccountStatus;
    // Platform-reported when verification/OAuth has run; null otherwise.
    followerCount: number | null;
  };
  // Internal outreach tracking (slice 4). Null while the candidate has not
  // been marked contacted yet. Support-only — never exposed to advertisers
  // or creators through any read model.
  outreach: {
    id: string;
    status: ManagedBriefOutreachStatus;
    contactedAt: Date;
    respondedAt: Date | null;
    note: string | null;
    contactedById: string;
    respondedById: string | null;
  } | null;
};

/**
 * An existing platform account support can pick from when adding a candidate
 * (slice 3). Resolved from real CreatorProfile/SocialAccount rows only — the
 * add path never accepts typed-in identity data.
 */
export type ManagedBriefCandidateAccountOption = {
  profileId: string;
  creatorName: string;
  username: string;
  accountId: string;
  platform: Platform;
  accountUsername: string;
  category: Category | null;
};

/**
 * Valid candidate status transitions (slice 3). The linear happy path plus
 * DECLINED as an exit from any active state. DECLINED and SELECTED are
 * terminal — nothing reopens them. The service enforces this map server-side;
 * the client only names the CURRENT candidate, never the next status.
 */
export const MANAGED_BRIEF_CANDIDATE_TRANSITIONS = {
  PROSPECT: ["CONTACTED", "DECLINED"],
  CONTACTED: ["INTERESTED", "DECLINED"],
  INTERESTED: ["SELECTED", "DECLINED"],
  DECLINED: [],
  SELECTED: [],
} as const satisfies Record<
  ManagedBriefCandidateStatus,
  readonly ManagedBriefCandidateStatus[]
>;

/**
 * Valid support-review status transitions (slice 2). SUBMITTED → IN_REVIEW →
 * CLOSED; CLOSED is terminal and nothing reopens a closed brief.
 */
export const MANAGED_BRIEF_REVIEW_TRANSITIONS = {
  SUBMITTED: ["IN_REVIEW"],
  IN_REVIEW: ["CLOSED"],
  CLOSED: [],
} as const satisfies Record<ManagedBriefStatus, readonly ManagedBriefStatus[]>;

/**
 * The candidate payload when a fresh add or status change must re-render the
 * workspace — kept minimal; the page refetches the full list. briefId lets
 * the action layer revalidate exactly the affected brief page.
 */
export type ManagedBriefCandidateMutationResult = {
  candidateId: string;
  briefId: string;
  status: ManagedBriefCandidateStatus;
};

/**
 * The outreach payload when marking contacted / recording a response must
 * re-render the workspace — same shape rules as the candidate result.
 */
export type ManagedBriefOutreachMutationResult = {
  outreachId: string;
  candidateId: string;
  briefId: string;
  status: ManagedBriefOutreachStatus;
};

/**
 * Valid OUTREACH transitions (slice 4). CONTACTED is written once at record
 * creation; the creator's response moves the record to INTERESTED or
 * DECLINED. Both are terminal — a response can be recorded exactly once.
 * The service enforces this map server-side against the STORED status; the
 * client only presses one of two fixed response buttons and never names a
 * raw status in a free-form field.
 */
export const MANAGED_BRIEF_OUTREACH_TRANSITIONS = {
  CONTACTED: ["INTERESTED", "DECLINED"],
  INTERESTED: [],
  DECLINED: [],
} as const satisfies Record<
  ManagedBriefOutreachStatus,
  readonly ManagedBriefOutreachStatus[]
>;

/** Shape returned by any server action / route handler. */
export type ActionResult<T = undefined> =
  | { success: true; data: T }
  | { success: false; error: string; fieldErrors?: Record<string, string[]> };
