import type {
  AgreementStatus,
  ApplicationStatus,
  CampaignStatus,
  Category,
  ManagedBriefCandidateStatus,
  ManagedBriefOutreachStatus,
  ManagedBriefStatus,
  Platform,
  PostStatus,
  SocialAccountStatus,
  UserRole,
} from "@/types";

export const APP_NAME = "Agenda";
export const APP_TAGLINE = "Turn attention into income.";

export const PLATFORM_LABELS: Record<Platform, string> = {
  TIKTOK: "TikTok",
  X: "X",
  INSTAGRAM: "Instagram",
  YOUTUBE: "YouTube",
  FACEBOOK: "Facebook",
};

export const CATEGORY_LABELS: Record<Category, string> = {
  FASHION: "Fashion",
  BEAUTY: "Beauty",
  FITNESS: "Fitness",
  TECH: "Tech",
  GAMING: "Gaming",
  FOOD: "Food",
  TRAVEL: "Travel",
  LIFESTYLE: "Lifestyle",
  COMEDY: "Comedy",
  MUSIC: "Music",
  SPORTS: "Sports",
  EDUCATION: "Education",
  FINANCE: "Finance",
  OTHER: "Other",
};

export const ROLE_LABELS: Record<UserRole, string> = {
  CREATOR: "Creator",
  ADVERTISER: "Advertiser",
  // Stage 14D — trusted internal operator (support review, dispute handling).
  SUPPORT: "Support",
};

export const DEFAULT_CURRENCY = "NGN" as const;

/**
 * Curated Paystack NGN bank codes for the creator payout form (Stage 14C).
 *
 * DISPLAY-ONLY DATA: this list only populates the bank selector. The
 * authoritative check happens server-side — the provider resolves the account
 * number against the chosen bank code and refuses an account-name mismatch,
 * so a wrong or stale code simply fails verification.
 */
export type PayoutBank = { code: string; name: string };

export const PAYOUT_NGN_BANKS: readonly PayoutBank[] = [
  { code: "044", name: "Access Bank" },
  { code: "011", name: "First Bank of Nigeria" },
  { code: "070", name: "Fidelity Bank" },
  { code: "214", name: "FCMB" },
  { code: "058", name: "GTBank" },
  { code: "082", name: "Keystone Bank" },
  { code: "50211", name: "Kuda Microfinance Bank" },
  { code: "50515", name: "Moniepoint Microfinance Bank" },
  { code: "999992", name: "OPay" },
  { code: "999991", name: "PalmPay" },
  { code: "101", name: "ProvidusBank" },
  { code: "221", name: "Stanbic IBTC Bank" },
  { code: "032", name: "Union Bank" },
  { code: "033", name: "United Bank for Africa" },
  { code: "035", name: "Wema Bank" },
  { code: "057", name: "Zenith Bank" },
];

/** Resolves a Paystack bank code to its display name, or null when unknown. */
export function payoutBankNameForCode(code: string): string | null {
  return PAYOUT_NGN_BANKS.find((bank) => bank.code === code)?.name ?? null;
}

/**
 * Platforms a creator can link today. Kept here (not in a validation file)
 * because this module only uses type-only imports and is therefore safe to
 * import from client components without pulling in the Prisma runtime.
 */
export const CONNECTABLE_PLATFORMS = ["TIKTOK", "X"] as const;
export type ConnectablePlatform = (typeof CONNECTABLE_PLATFORMS)[number];

/**
 * Platforms a campaign can target today. Mirrors the creator link platforms —
 * both TikTok and X — until Instagram/YouTube campaigns are supported.
 */
export const CAMPAIGN_PLATFORMS = ["TIKTOK", "X"] as const;
export type CampaignPlatform = (typeof CAMPAIGN_PLATFORMS)[number];

/**
 * Suggestions shown in the campaign form. These are examples only — the
 * advertiser types their own requirements and nothing is generated for them.
 */
export const CONTENT_REQUIREMENT_SUGGESTIONS = [
  "Mention the brand",
  "Use the campaign hashtag",
  "Include the product in frame",
  "Specific call to action",
] as const;

/**
 * Rate-card content/service types (Stage 12). The creator picks one per
 * listed rate; "Package" covers bundled deliverables across formats.
 */
export const RATE_CARD_SERVICE_TYPES = [
  "POST",
  "VIDEO",
  "THREAD",
  "PACKAGE",
  "OTHER",
] as const;
export type RateCardServiceType = (typeof RATE_CARD_SERVICE_TYPES)[number];

export const RATE_CARD_SERVICE_TYPE_LABELS: Record<
  RateCardServiceType,
  string
> = {
  POST: "Post",
  VIDEO: "Video",
  THREAD: "Thread",
  PACKAGE: "Package",
  OTHER: "Other",
};

export const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
  PENDING: "Pending",
  ACCEPTED: "Accepted",
  REJECTED: "Rejected",
  WITHDRAWN: "Withdrawn",
};

export const SOCIAL_ACCOUNT_STATUS_LABELS: Record<
  SocialAccountStatus,
  string
> = {
  PENDING_VERIFICATION: "Pending verification",
  VERIFIED: "Verified",
  CONNECTED: "Connected",
};

export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
  DRAFT: "Draft",
  PUBLISHED: "Published",
  APPLICATIONS_CLOSED: "Applications closed",
  IN_PROGRESS: "In progress",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

export const AGREEMENT_STATUS_LABELS: Record<AgreementStatus, string> = {
  ACTIVE: "Active",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

export const POST_STATUS_LABELS: Record<PostStatus, string> = {
  SUBMITTED: "Submitted",
  VERIFYING: "Verifying",
  VERIFIED: "Verified",
  REJECTED: "Rejected",
};

/**
 * Agenda Managed (V1) — the channels a managed brief can target today.
 * Mirrors the marketplace campaign platforms (TikTok/X) so the taxonomy stays
 * honest about what Agenda can actually run; widening the list is a code
 * change, not a silent client option. Type-only import keeps this module safe
 * for client components.
 */
export const MANAGED_BRIEF_CHANNELS = ["TIKTOK", "X"] as const;
export type ManagedBriefChannel = (typeof MANAGED_BRIEF_CHANNELS)[number];

export const MANAGED_BRIEF_STATUS_LABELS: Record<ManagedBriefStatus, string> = {
  SUBMITTED: "Submitted",
  IN_REVIEW: "In review",
  CLOSED: "Closed",
};

/**
 * Agenda Managed (V1, slice 3) — internal sourcing status of a support
 * candidate. Support-workspace display only; advertisers never see these.
 * Type-only import keeps this module safe for client components.
 */
export const MANAGED_BRIEF_CANDIDATE_STATUS_LABELS: Record<
  ManagedBriefCandidateStatus,
  string
> = {
  PROSPECT: "Prospect",
  CONTACTED: "Contacted",
  INTERESTED: "Interested",
  DECLINED: "Declined",
  SELECTED: "Selected",
};

/**
 * Tone for candidate status badges (slice 3). Mirrors the brief status badge
 * convention — a pure display map, no logic.
 */
export const MANAGED_BRIEF_CANDIDATE_STATUS_TONES: Record<
  ManagedBriefCandidateStatus,
  "neutral" | "accent" | "muted" | "warning" | "danger"
> = {
  PROSPECT: "neutral",
  CONTACTED: "muted",
  INTERESTED: "warning",
  DECLINED: "danger",
  SELECTED: "accent",
};

/**
 * Agenda Managed (V1, slice 4) — internal outreach status of a sourcing
 * candidate. Support-workspace display only; advertisers never see these.
 * No row = "not contacted yet" (rendered separately in the UI).
 */
export const MANAGED_BRIEF_OUTREACH_STATUS_LABELS: Record<
  ManagedBriefOutreachStatus,
  string
> = {
  CONTACTED: "Contacted",
  INTERESTED: "Interested",
  DECLINED: "Declined",
};

/**
 * Platforms a post can be submitted for today. Mirrors the creator link and
 * campaign target platforms — both TikTok and X — until the other platforms
 * are supported end to end.
 */
export const POST_PLATFORMS = ["TIKTOK", "X"] as const;
export type PostPlatform = (typeof POST_PLATFORMS)[number];
