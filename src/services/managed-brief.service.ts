import "server-only";

import type { Prisma } from "@/generated/prisma/client";

import { getSupportActor } from "@/lib/authz";
import { MANAGED_BRIEF_CHANNELS } from "@/lib/constants";
import {
  isManagedBriefSourcingAccountEligible,
} from "@/lib/managed-brief-eligibility";
import { isSupportedCurrency, toMinorUnits } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import {
  MANAGED_BRIEF_CANDIDATE_TRANSITIONS,
  MANAGED_BRIEF_OUTREACH_TRANSITIONS,
  type ManagedBriefCandidateAccountOption,
  type ManagedBriefCandidateStatus,
  type ManagedBriefCandidateMutationResult,
  type ManagedBriefCandidateSummary,
  type ManagedBriefDetail,
  type ManagedBriefOutreachMutationResult,
  type ManagedBriefOutreachStatus,
  type ManagedBriefStatus,
  type ManagedBriefSupportDetail,
  type ManagedBriefSupportSummary,
  type ManagedBriefSummary,
} from "@/types";
import type {
  ManagedBriefCandidateAddInput,
  ManagedBriefCandidateNoteInput,
  ManagedBriefOutreachContactInput,
  ManagedBriefOutreachNoteInput,
  ManagedBriefOutreachResponseInput,
  ManagedBriefWriteInput,
} from "@/validation/managed-brief";

// ---------------------------------------------------------------------------
// Agenda Managed (V1) — private managed-marketing briefs.
//
// Authorization model (fail closed on every path):
//   - Identity NEVER comes from client input. The owning advertiser is
//     resolved from the server session (role ADVERTISER + their
//     AdvertiserProfile), and the advertiserId is part of every owner read's
//     where-clause — a guessed or foreign id returns null, never data.
//   - Support reads AND status transitions go through the Stage 14D
//     trusted-operator seam (getSupportActor: SUPPORT role + fresh roster
//     re-read from the DB on every call — revocation ends access instantly).
//   - Everyone else — other advertisers, creators, anonymous callers — gets
//     nothing. There is no public read of a managed brief anywhere, and no
//     advertiser/creator path can reach the review actions.
//
// Status ownership (slice 2): the ONLY transitions are SUBMITTED → IN_REVIEW
// and IN_REVIEW → CLOSED, performed exclusively by the support transition
// below. The target status is decided server-side from the stored status —
// the client never names the next state. Review timestamps/attribution are
// audit-fact columns on the row itself (the Campaign.publishedAt /
// Milestone.advertiserConfirmedAt convention), set only by that transition.
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

// Core row plus the review audit facts and the fields only the detail views
// render. The *ById attribution columns are NOT selected here — they appear
// only in the support summary below, never on an advertiser-facing read.
const briefDetailSelect = {
  ...briefSummarySelect,
  description: true,
  creatorRequirements: true,
  updatedAt: true,
  reviewStartedAt: true,
  closedAt: true,
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
    reviewStartedAt: row.reviewStartedAt,
    closedAt: row.closedAt,
  };
}

// Support list rows: same core facts plus WHO the brief is from (display
// only) and the operator attribution for each review transition.
const supportSummarySelect = {
  ...briefSummarySelect,
  reviewStartedAt: true,
  closedAt: true,
  reviewStartedById: true,
  closedById: true,
  advertiser: { select: { companyName: true } },
} satisfies Prisma.ManagedBriefSelect;

// Support detail rows: everything the owner sees plus the operator ids.
const supportDetailSelect = {
  ...briefDetailSelect,
  reviewStartedById: true,
  closedById: true,
} satisfies Prisma.ManagedBriefSelect;

type SupportDetailRow = Prisma.ManagedBriefGetPayload<{
  select: typeof supportDetailSelect;
}>;

function toSupportDetail(row: SupportDetailRow): ManagedBriefSupportDetail {
  return {
    ...toBriefDetail(row),
    reviewStartedById: row.reviewStartedById,
    closedById: row.closedById,
  };
}

type SupportSummaryRow = Prisma.ManagedBriefGetPayload<{
  select: typeof supportSummarySelect;
}>;

function toSupportSummary(row: SupportSummaryRow): ManagedBriefSupportSummary {
  return {
    ...toBriefSummary(row),
    advertiserCompanyName: row.advertiser.companyName,
    reviewStartedAt: row.reviewStartedAt,
    closedAt: row.closedAt,
    reviewStartedById: row.reviewStartedById,
    closedById: row.closedById,
  };
}

/**
 * Create a brief for the given advertiser (resolved from the session by the
 * caller — see getViewerAdvertiser). Status is server-owned: every new brief
 * starts as SUBMITTED and nothing in this slice can move it.
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
 * brief. Support must use the support reads below — this function never
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

// ---------------------------------------------------------------------------
// Support review (slice 2) — every function below is gated by the Stage 14D
// seam. The roster check is re-read fresh from the database on each call, so
// a roster revocation ends access on the very next request.
// ---------------------------------------------------------------------------

/**
 * The review queue: every submitted brief, newest first. Rostered SUPPORT
 * only — any other role (including ADVERTISER/CREATOR) and any revoked or
 * roster-less SUPPORT session gets an empty list, never data.
 */
export async function listManagedBriefsForSupport(): Promise<
  ManagedBriefSupportSummary[]
> {
  const actor = await getSupportActor();

  if (!actor) {
    return [];
  }

  const rows = await prisma.managedBrief.findMany({
    orderBy: { createdAt: "desc" },
    select: supportSummarySelect,
  });

  return rows.map(toSupportSummary);
}

/**
 * Get one brief for SUPPORT via the Stage 14D seam — the owner's full detail
 * plus the internal operator-attribution ids. Any other role resolves to null
 * here: support access never bypasses a user's own scoping, it only adds an
 * internal operator read.
 */
export async function getManagedBriefForSupport(
  briefId: string,
): Promise<ManagedBriefSupportDetail | null> {
  const actor = await getSupportActor();

  if (!actor) {
    return null;
  }

  const row = await prisma.managedBrief.findFirst({
    where: { id: briefId },
    select: supportDetailSelect,
  });

  return row ? toSupportDetail(row) : null;
}

/**
 * Advance a brief through the review lifecycle: SUBMITTED → IN_REVIEW →
 * CLOSED. CLOSED is terminal; no other transition exists.
 *
 * Authorization: the actor comes ONLY from getSupportActor() (server session
 * + fresh roster re-read) — never from an argument, so no client can forge
 * operator identity. The target status is derived server-side from the
 * stored status; the client never supplies it.
 *
 * Concurrency: the status flip is a conditional UPDATE whose where-clause
 * carries the CURRENT status, so two simultaneous transitions cannot both
 * match — the loser gets count 0 and a clear "already changed" error, and
 * the fact columns are written atomically with the flip.
 */
const SUPPORT_TRANSITIONS: Partial<
  Record<ManagedBriefStatus, { next: ManagedBriefStatus; action: "START_REVIEW" | "CLOSE" }>
> = {
  SUBMITTED: { next: "IN_REVIEW", action: "START_REVIEW" },
  IN_REVIEW: { next: "CLOSED", action: "CLOSE" },
};

export async function transitionManagedBriefForSupport(
  briefId: string,
): Promise<
  | { success: true; data: { status: ManagedBriefStatus } }
  | { success: false; error: string }
> {
  // Identity + permission from server facts only. A non-support or revoked
  // session is indistinguishable from "not allowed" — fail closed.
  const actor = await getSupportActor();

  if (!actor) {
    return { success: false, error: "Support authorization required." };
  }

  const brief = await prisma.managedBrief.findFirst({
    where: { id: briefId },
    select: { id: true, status: true },
  });

  if (!brief) {
    return { success: false, error: "Brief not found." };
  }

  const transition = SUPPORT_TRANSITIONS[brief.status];

  if (!transition) {
    return { success: false, error: "This brief is closed and cannot change status." };
  }

  const now = new Date();

  const result = await prisma.managedBrief.updateMany({
    where: {
      id: briefId,
      // The current status in the where-clause makes the transition atomic:
      // a brief that moved between the read and the write yields count 0.
      status: brief.status,
    },
    data: {
      status: transition.next,
      ...(transition.action === "START_REVIEW"
        ? { reviewStartedAt: now, reviewStartedById: actor.id }
        : { closedAt: now, closedById: actor.id }),
    },
  });

  if (result.count === 0) {
    return { success: false, error: "This brief's status already changed. Refresh and try again." };
  }

  return { success: true, data: { status: transition.next } };
}

// ---------------------------------------------------------------------------
// Sourcing candidates (slice 3) — internal, support-only records referencing
// EXISTING creator identity data. Every function below is gated by the same
// Stage 14D seam as the review path above; a lost or revoked roster entry
// fails closed on every call.
//
// Privacy guarantees (structural, not convention):
//   - No advertiser-facing function in this file selects any candidate table.
//   - No creator-facing function exists for candidates at all in this slice.
//   - Candidate reads/writes resolve the actor ONLY from getSupportActor();
//     no argument, form field or client payload can influence identity or
//     permission.
// ---------------------------------------------------------------------------

const candidateSummarySelect = {
  id: true,
  status: true,
  note: true,
  addedById: true,
  statusUpdatedAt: true,
  statusUpdatedById: true,
  createdAt: true,
  updatedAt: true,
  // Slice 5 traceability: the marketplace campaign this candidate became,
  // null while unconverted. Support-only visibility into the outcome of the
  // sourcing pipeline — the candidate's status stays SELECTED (terminal);
  // this link IS the conversion record, not a new status.
  campaignId: true,
  creator: {
    select: {
      id: true,
      username: true,
      category: true,
      // Self-reported by the creator — the UI labels it as such.
      followerCount: true,
      user: { select: { name: true } },
    },
  },
  socialAccount: {
    select: {
      id: true,
      platform: true,
      username: true,
      profileUrl: true,
      status: true,
      followerCount: true,
    },
  },
  // Slice 4: the internal outreach record, when the candidate has been
  // marked contacted. Support-only — never selected by any advertiser- or
  // creator-facing read.
  outreach: {
    select: {
      id: true,
      status: true,
      contactedAt: true,
      respondedAt: true,
      note: true,
      contactedById: true,
      respondedById: true,
    },
  },
} satisfies Prisma.ManagedBriefSourcingCandidateSelect;

type CandidateSummaryRow = Prisma.ManagedBriefSourcingCandidateGetPayload<{
  select: typeof candidateSummarySelect;
}>;

function toCandidateSummary(row: CandidateSummaryRow): ManagedBriefCandidateSummary {
  return {
    id: row.id,
    status: row.status,
    note: row.note,
    addedById: row.addedById,
    statusUpdatedAt: row.statusUpdatedAt,
    statusUpdatedById: row.statusUpdatedById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    campaignId: row.campaignId,
    creator: {
      profileId: row.creator.id,
      name: row.creator.user.name,
      username: row.creator.username,
      category: row.creator.category,
      followerCount: row.creator.followerCount,
    },
    account: {
      accountId: row.socialAccount.id,
      platform: row.socialAccount.platform,
      username: row.socialAccount.username,
      profileUrl: row.socialAccount.profileUrl,
      status: row.socialAccount.status,
      followerCount: row.socialAccount.followerCount,
    },
    outreach: row.outreach
      ? {
          id: row.outreach.id,
          status: row.outreach.status,
          contactedAt: row.outreach.contactedAt,
          respondedAt: row.outreach.respondedAt,
          note: row.outreach.note,
          contactedById: row.outreach.contactedById,
          respondedById: row.outreach.respondedById,
        }
      : null,
  };
}

/**
 * The Support workspace's candidate list for one brief. Rostered SUPPORT
 * only — every other session (advertiser, creator, anonymous, revoked
 * support) resolves to an empty list, never data.
 */
export async function listManagedBriefCandidatesForSupport(
  briefId: string,
): Promise<ManagedBriefCandidateSummary[]> {
  const actor = await getSupportActor();

  if (!actor) {
    return [];
  }

  const rows = await prisma.managedBriefSourcingCandidate.findMany({
    where: { briefId },
    orderBy: { createdAt: "desc" },
    select: candidateSummarySelect,
  });

  return rows.map(toCandidateSummary);
}

/**
 * Existing creator accounts support can pick from when adding a candidate.
 * Resolved from real CreatorProfile/SocialAccount rows only — the add path
 * never accepts typed-in identity data. Ordered for a stable picker.
 */
export async function listManagedBriefCandidateAccountOptionsForSupport(): Promise<
  ManagedBriefCandidateAccountOption[]
> {
  const actor = await getSupportActor();

  if (!actor) {
    return [];
  }

  const profiles = await prisma.creatorProfile.findMany({
    orderBy: [{ username: "asc" }],
    select: {
      id: true,
      username: true,
      category: true,
      user: { select: { name: true } },
      socialAccounts: {
        // Sourcing eligibility lives IN the query, not in the UI: Support is
        // only ever offered accounts the marketplace can actually use —
        // connectable platforms (TIKTOK/X) that are OAuth-connected
        // (platformUserId present). A claimed-only or unsupported-platform
        // account can never back a convertible candidate, so it is never a
        // valid choice here. (The write path re-checks the same rule.)
        where: {
          platform: { in: [...MANAGED_BRIEF_CHANNELS] },
          platformUserId: { not: null },
        },
        orderBy: [{ platform: "asc" }, { username: "asc" }],
        select: {
          id: true,
          platform: true,
          username: true,
        },
      },
    },
  });

  const options: ManagedBriefCandidateAccountOption[] = [];

  for (const profile of profiles) {
    for (const account of profile.socialAccounts) {
      options.push({
        profileId: profile.id,
        creatorName: profile.user.name,
        username: profile.username,
        accountId: account.id,
        platform: account.platform,
        accountUsername: account.username,
        category: profile.category,
      });
    }
  }

  return options;
}

/**
 * Add a candidate creator to a brief. The creator/account MUST be existing
 * records (ids only) and the account MUST belong to the creator — the
 * service verifies the pairing against the database instead of trusting the
 * form. Creator identity data is never duplicated: the candidate row stores
 * references.
 *
 * Sourcing eligibility (enforced HERE, not only in the picker UI): the
 * pinned account must be on a connectable platform (TIKTOK/X) AND be
 * OAuth-connected (platformUserId present). Conversion later inherits this
 * account's platform into the Campaign, and the marketplace application
 * gate requires a connected account on that platform — pinning an unusable
 * account would hand the selected creator a campaign they can never apply
 * to. The same rule is enforced at the SELECTED transition and again at
 * conversion, so this boundary is one layer of defense, not the only one.
 *
 * Duplicates (same brief + creator + account) are rejected by the DATABASE
 * unique constraint — the service pre-check gives a friendly message and the
 * constraint catches a lost race. Added/updated attribution comes ONLY from
 * getSupportActor().
 */
export async function addManagedBriefCandidateForSupport(
  input: ManagedBriefCandidateAddInput,
): Promise<
  | { success: true; data: ManagedBriefCandidateMutationResult }
  | { success: false; error: string }
> {
  const actor = await getSupportActor();

  if (!actor) {
    return { success: false, error: "Support authorization required." };
  }

  // The brief must exist. Any status is allowed: sourcing is internal and a
  // brief may be worked while CLOSED (history stays correct — see also
  // removeManagedBriefCandidateForSupport).
  const brief = await prisma.managedBrief.findFirst({
    where: { id: input.briefId },
    select: { id: true },
  });

  if (!brief) {
    return { success: false, error: "Brief not found." };
  }

  // The account must be a real record AND belong to the claimed creator —
  // the pairing is verified, never assumed from client input. Its
  // eligibility fields are read in the same query so the sourcing rule is
  // evaluated against the STORED row, never against form data.
  const account = await prisma.socialAccount.findFirst({
    where: { id: input.socialAccountId, creatorId: input.creatorProfileId },
    select: { id: true, platform: true, platformUserId: true },
  });

  if (!account) {
    return {
      success: false,
      error: "That account does not belong to the selected creator.",
    };
  }

  // A managed-brief candidate must be pinnable to an account the creator
  // can actually apply with later (connectable platform + OAuth-connected).
  if (!isManagedBriefSourcingAccountEligible(account)) {
    return {
      success: false,
      error:
        "That account can't be used for sourcing — the creator must connect it (TikTok or X) before it can be a candidate.",
    };
  }

  try {
    const candidate = await prisma.managedBriefSourcingCandidate.create({
      data: {
        briefId: input.briefId,
        creatorId: input.creatorProfileId,
        socialAccountId: input.socialAccountId,
        status: "PROSPECT",
        // Empty string normalizes to null so "no note" has one representation.
        note: input.note || null,
        addedById: actor.id,
      },
      select: { id: true, status: true, briefId: true },
    });

    return {
      success: true,
      data: {
        candidateId: candidate.id,
        briefId: candidate.briefId,
        status: candidate.status,
      },
    };
  } catch (error) {
    // The (brief, creator, account) unique constraint is the authoritative
    // duplicate guard: a lost pre-check race lands here, not on a second row.
    if (isUniqueViolation(error)) {
      return {
        success: false,
        error: "This creator is already a candidate on this brief (same account).",
      };
    }

    console.error("addManagedBriefCandidateForSupport failed", error);
    return { success: false, error: "Could not add the candidate. Please try again." };
  }
}

/**
 * Advance a candidate's sourcing status. The next status is derived
 * server-side from the STORED status via the transition map — the client
 * names the candidate only. Concurrency: a conditional updateMany whose
 * where-clause carries the CURRENT status, so two simultaneous transitions
 * cannot both match (same pattern as the brief review transition).
 */
export async function transitionManagedBriefCandidateForSupport(
  candidateId: string,
): Promise<
  | { success: true; data: ManagedBriefCandidateMutationResult }
  | { success: false; error: string }
> {
  const actor = await getSupportActor();

  if (!actor) {
    return { success: false, error: "Support authorization required." };
  }

  // The account's eligibility fields ride along so the SELECTED gate can be
  // evaluated against the STORED account in the same read.
  const candidate = await prisma.managedBriefSourcingCandidate.findFirst({
    where: { id: candidateId },
    select: {
      id: true,
      status: true,
      briefId: true,
      socialAccount: {
        select: { platform: true, platformUserId: true },
      },
    },
  });

  if (!candidate) {
    return { success: false, error: "Candidate not found." };
  }

  const [next] = MANAGED_BRIEF_CANDIDATE_TRANSITIONS[candidate.status];

  if (!next) {
    return {
      success: false,
      error: `A ${candidate.status.toLowerCase()} candidate cannot change status.`,
    };
  }

  // SELECTED is the boundary that makes a candidate convertible: a candidate
  // whose pinned account cannot satisfy the marketplace application gate
  // (connectable platform + OAuth-connected) must never reach it. This
  // catches legacy rows pinned before the rule existed. Nothing about the
  // pinned account is rewritten here — if the creator later connects the
  // account (platformUserId becomes non-null), the transition simply works.
  if (
    next === "SELECTED" &&
    !isManagedBriefSourcingAccountEligible(candidate.socialAccount)
  ) {
    return {
      success: false,
      error:
        "This candidate's pinned account is not connected (TikTok or X), so they can't be selected. Have the creator connect the account first.",
    };
  }

  const now = new Date();

  const result = await prisma.managedBriefSourcingCandidate.updateMany({
    where: {
      id: candidateId,
      // Current status in the where-clause makes the transition atomic.
      status: candidate.status,
    },
    data: {
      status: next,
      statusUpdatedAt: now,
      statusUpdatedById: actor.id,
    },
  });

  if (result.count === 0) {
    return {
      success: false,
      error: "This candidate's status already changed. Refresh and try again.",
    };
  }

  return {
    success: true,
    data: { candidateId, briefId: candidate.briefId, status: next },
  };
}

/**
 * Mark a candidate DECLINED — the exit from any active state (PROSPECT,
 * CONTACTED, INTERESTED). Kept as a separate explicit action from the linear
 * advance above because DECLINED is a branch, not the next step. The target
 * status is still fixed SERVER-side (never a client field); this function
 * merely validates against the same transition map that the advance uses.
 */
export async function declineManagedBriefCandidateForSupport(
  candidateId: string,
): Promise<
  | { success: true; data: ManagedBriefCandidateMutationResult }
  | { success: false; error: string }
> {
  const actor = await getSupportActor();

  if (!actor) {
    return { success: false, error: "Support authorization required." };
  }

  const candidate = await prisma.managedBriefSourcingCandidate.findFirst({
    where: { id: candidateId },
    select: { id: true, status: true, briefId: true },
  });

  if (!candidate) {
    return { success: false, error: "Candidate not found." };
  }

  // Widen the literal tuple to the enum array so includes() is usable.
  const allowed: readonly ManagedBriefCandidateStatus[] =
    MANAGED_BRIEF_CANDIDATE_TRANSITIONS[candidate.status];

  if (!allowed.includes("DECLINED")) {
    return {
      success: false,
      error: `A ${candidate.status.toLowerCase()} candidate cannot be declined.`,
    };
  }

  const now = new Date();

  const result = await prisma.managedBriefSourcingCandidate.updateMany({
    where: {
      id: candidateId,
      // Current status in the where-clause makes the transition atomic.
      status: candidate.status,
    },
    data: {
      status: "DECLINED",
      statusUpdatedAt: now,
      statusUpdatedById: actor.id,
    },
  });

  if (result.count === 0) {
    return {
      success: false,
      error: "This candidate's status already changed. Refresh and try again.",
    };
  }

  return {
    success: true,
    data: { candidateId, briefId: candidate.briefId, status: "DECLINED" },
  };
}

/**
 * Set or clear a candidate's internal note (support-eyes only). Attribution
 * of the write is recorded via the row's updatedAt; the note itself is
 * content, not a state transition, so it never touches the status machine.
 */
export async function setManagedBriefCandidateNoteForSupport(
  input: ManagedBriefCandidateNoteInput,
): Promise<
  | { success: true; data: ManagedBriefCandidateMutationResult }
  | { success: false; error: string }
> {
  const actor = await getSupportActor();

  if (!actor) {
    return { success: false, error: "Support authorization required." };
  }

  try {
    const candidate = await prisma.managedBriefSourcingCandidate.update({
      where: { id: input.candidateId },
      // Empty string normalizes to null so "no note" has one representation.
      data: { note: input.note || null },
      select: { id: true, status: true, briefId: true },
    });

    return {
      success: true,
      data: {
        candidateId: candidate.id,
        briefId: candidate.briefId,
        status: candidate.status,
      },
    };
  } catch (error) {
    // Prisma P2025: the where-clause matched no row.
    if (isRecordNotFound(error)) {
      return { success: false, error: "Candidate not found." };
    }

    console.error("setManagedBriefCandidateNoteForSupport failed", error);
    return { success: false, error: "Could not save the note. Please try again." };
  }
}

/**
 * Remove a candidate from a brief. A hard delete by design: candidate rows
 * are internal working data, not an audit system — the sourcing history the
 * business cares about lives in the brief's review facts and (later) the
 * campaign itself.
 */
export async function removeManagedBriefCandidateForSupport(
  candidateId: string,
): Promise<
  | { success: true; data: ManagedBriefCandidateMutationResult }
  | { success: false; error: string }
> {
  const actor = await getSupportActor();

  if (!actor) {
    return { success: false, error: "Support authorization required." };
  }

  try {
    const candidate = await prisma.managedBriefSourcingCandidate.delete({
      where: { id: candidateId },
      select: { id: true, status: true, briefId: true },
    });

    return {
      success: true,
      data: {
        candidateId: candidate.id,
        briefId: candidate.briefId,
        status: candidate.status,
      },
    };
  } catch (error) {
    if (isRecordNotFound(error)) {
      return { success: false, error: "Candidate not found." };
    }

    console.error("removeManagedBriefCandidateForSupport failed", error);
    return { success: false, error: "Could not remove the candidate. Please try again." };
  }
}

// ---------------------------------------------------------------------------
// Outreach tracking (slice 4) — internal record of off-platform contact with
// a candidate and the creator's response. NO email/DM/SMS is sent by any of
// these functions; they only record what support did off-platform.
//
// The record is created by the "mark contacted" action (one per candidate,
// DB-unique) and the response is recorded by two fixed actions. Every
// function is gated by the same Stage 14D seam; every transition is validated
// against the STORED status — never a client-supplied target.
// ---------------------------------------------------------------------------

/**
 * Mark a candidate CONTACTED: creates the candidate's single outreach record.
 * Repeated actions are refused by the service pre-check AND by the database
 * unique constraint (candidateId) if a lost race slips past the pre-check.
 */
export async function contactManagedBriefCandidateForSupport(
  input: ManagedBriefOutreachContactInput,
): Promise<
  | { success: true; data: ManagedBriefOutreachMutationResult }
  | { success: false; error: string }
> {
  const actor = await getSupportActor();

  if (!actor) {
    return { success: false, error: "Support authorization required." };
  }

  const candidate = await prisma.managedBriefSourcingCandidate.findFirst({
    where: { id: input.candidateId },
    select: { id: true, briefId: true, status: true, outreach: { select: { id: true } } },
  });
  if (!candidate) {
    return { success: false, error: "Candidate not found." };
  }

  if (candidate.outreach) {
    return {
      success: false,
      error: "This candidate has already been marked contacted.",
    };
  }

  try {
    const outreach = await prisma.managedBriefCandidateOutreach.create({
      data: {
        candidateId: input.candidateId,
        status: "CONTACTED",
        contactedAt: new Date(),
        note: input.note || null,
        contactedById: actor.id,
      },
      select: { id: true, status: true },
    });

    return {
      success: true,
      data: {
        outreachId: outreach.id,
        candidateId: input.candidateId,
        briefId: candidate.briefId,
        status: outreach.status,
      },
  };
  } catch (error) {
    // The candidateId unique constraint is the authoritative guard: a lost
    // race against a concurrent "mark contacted" lands here.
    if (isUniqueViolation(error)) {
      return {
        success: false,
        error: "This candidate has already been marked contacted.",
      };
    }

    console.error("contactManagedBriefCandidateForSupport failed", error);
    return { success: false, error: "Could not record the outreach. Please try again." };
  }
}

/**
 * Record the creator's response to outreach. The response kind (INTERESTED /
 * DECLINED) is expressed by WHICH action is invoked — never by a client
 * field naming a raw status — and the stored record must currently be in
 * CONTACTED for either to be legal. The response is recorded exactly once:
 * both terminal states refuse any further write. The optional note updates
 * the record's internal note atomically with the response.
 */
async function recordOutreachResponseForSupport(
  candidateId: string,
  response: "INTERESTED" | "DECLINED",
  note: string | undefined,
): Promise<
  | { success: true; data: ManagedBriefOutreachMutationResult }
  | { success: false; error: string }
> {
  const actor = await getSupportActor();

  if (!actor) {
    return { success: false, error: "Support authorization required." };
  }

  const outreach = await prisma.managedBriefCandidateOutreach.findFirst({
    where: { candidateId },
    select: { id: true, status: true, candidate: { select: { briefId: true } } },
  });

  if (!outreach) {
    return {
      success: false,
      error: "This candidate has not been marked contacted yet.",
    };
  }

  // Server-side validation against the STORED status: only CONTACTED may
  // move, and only to the response this action represents.
  const allowed: readonly ManagedBriefOutreachStatus[] =
    MANAGED_BRIEF_OUTREACH_TRANSITIONS[outreach.status];

  if (!allowed.includes(response)) {
    return {
      success: false,
      error:
        outreach.status === response
          ? "This response has already been recorded."
          : `A ${outreach.status.toLowerCase()} outreach cannot change again.`,
    };
  }

  const now = new Date();

  // Conditional update: the stored status must still be CONTACTED, so two
  // simultaneous response writes cannot both succeed — the loser gets count
  // 0 and a clear error (same pattern as the candidate/brief transitions).
  const result = await prisma.managedBriefCandidateOutreach.updateMany({
    where: { id: outreach.id, status: outreach.status },
    data: {
      status: response,
      respondedAt: now,
      respondedById: actor.id,
      // An explicit note on the response wins; otherwise keep the existing one.
      ...(note === undefined ? {} : { note: note || null }),
    },
  });

  if (result.count === 0) {
    return {
      success: false,
      error: "This outreach already has a response. Refresh and try again.",
    };
  }

  return {
    success: true,
    data: {
      outreachId: outreach.id,
      candidateId,
      briefId: outreach.candidate.briefId,
      status: response,
    },
  };
}

/** Record the creator as INTERESTED (fixed server-side target). */
export async function recordManagedBriefOutreachInterestedForSupport(
  input: ManagedBriefOutreachResponseInput,
): Promise<
  | { success: true; data: ManagedBriefOutreachMutationResult }
  | { success: false; error: string }
> {
  return recordOutreachResponseForSupport(input.candidateId, "INTERESTED", input.note);
}

/** Record the creator as DECLINED (fixed server-side target). */
export async function recordManagedBriefOutreachDeclinedForSupport(
  input: ManagedBriefOutreachResponseInput,
): Promise<
  | { success: true; data: ManagedBriefOutreachMutationResult }
  | { success: false; error: string }
> {
  return recordOutreachResponseForSupport(input.candidateId, "DECLINED", input.note);
}

/**
 * Update the outreach record's internal note (support-eyes only). The note
 * is content, not a transition — it never touches the outreach status
 * machine and is allowed in every state, including terminal ones.
 */
export async function setManagedBriefOutreachNoteForSupport(
  input: ManagedBriefOutreachNoteInput,
): Promise<
  | { success: true; data: ManagedBriefOutreachMutationResult }
  | { success: false; error: string }
> {
  const actor = await getSupportActor();
  if (!actor) {
    return { success: false, error: "Support authorization required." };
  }

  try {
    const outreach = await prisma.managedBriefCandidateOutreach.update({
      where: { candidateId: input.candidateId },
      data: { note: input.note || null },
      select: { id: true, status: true, candidate: { select: { briefId: true } } },
    });

    return {
      success: true,
      data: {
        outreachId: outreach.id,
        candidateId: input.candidateId,
        briefId: outreach.candidate.briefId,
        status: outreach.status,
      },
    };
  } catch (error) {
    if (isRecordNotFound(error)) {
      return {
        success: false,
        error: "This candidate has not been marked contacted yet.",
      };
    }

    console.error("setManagedBriefOutreachNoteForSupport failed", error);
    return { success: false, error: "Could not save the outreach note. Please try again." };
  }
}

/**
 * Prisma unique-constraint violation (P2002) — the DB-level duplicate guard
 * for candidate creation (same detection convention as
 * verified-views.service.ts).
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

/** Prisma record-not-found (P2025) for update/delete by id. */
function isRecordNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2025"
  );
}
