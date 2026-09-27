import { z } from "zod";

import { Category } from "@/generated/prisma/client";
import { MANAGED_BRIEF_CHANNELS } from "@/lib/constants";
import { flattenFieldErrors } from "@/validation/errors";

const categoryEnumValues = Object.values(Category) as [
  Category,
  ...Category[],
];

/**
 * Agenda Managed (V1) — brief submission validation.
 *
 * Structural rules only. Identity and ownership never come from the form:
 * the advertiser is resolved server-side from the session (see
 * managed-brief.service.ts), and the brief status is server-owned — no client
 * field can set or change it.
 */

const channelValues = [...MANAGED_BRIEF_CHANNELS] as [
  (typeof MANAGED_BRIEF_CHANNELS)[number],
  ...(typeof MANAGED_BRIEF_CHANNELS)[number][],
];

/** Optional free-text field: trims and treats an empty string as absent. */
function optionalText(max: number, message: string) {
  return z
    .string()
    .trim()
    .max(max, { message })
    .transform((value) => (value === "" ? undefined : value))
    .optional();
}

export const managedBriefSchema = z.object({
  campaignGoal: z
    .string()
    .trim()
    .min(3, { message: "Describe your marketing goal." })
    .max(200, { message: "Goal must be 200 characters or fewer." }),
  description: z
    .string()
    .trim()
    .min(20, { message: "Describe the campaign in at least 20 characters." })
    .max(5000, { message: "Description must be 5000 characters or fewer." }),
  // Coerced from string input, then checked as a positive number. The service
  // converts to exact BigInt minor units at the single money boundary.
  budget: z.coerce
    .number({ message: "Enter a budget." })
    .positive({ message: "Budget must be greater than zero." })
    .max(1_000_000_000_000, { message: "Budget is too large." }),
  currency: z.enum(["NGN"], { message: "Choose a supported currency." }),
  targetAudience: z
    .string()
    .trim()
    .min(2, { message: "Describe who you're trying to reach." })
    .max(1000, { message: "Target audience is too long." }),
  targetPlatforms: z
    .array(z.enum(channelValues, { message: "Choose supported channels." }))
    .min(1, { message: "Choose at least one channel." })
    .max(5, { message: "Choose at most five channels." }),
  creatorRequirements: optionalText(
    2000,
    "Creator requirements must be 2000 characters or fewer.",
  ),
});

export type ManagedBriefInput = z.infer<typeof managedBriefSchema>;

/**
 * Everything the service needs. The budget arrives as a validated number;
 * converting it to exact BigInt minor units happens ONCE, server-side, in
 * the service layer — never from a client-supplied minor value.
 */
export type ManagedBriefWriteInput = ManagedBriefInput;

export type ManagedBriefFormResult =
  | { success: true; data: ManagedBriefInput }
  | { success: false; fieldErrors: Record<string, string[]> };

/**
 * Validate a brief submission from FormData. The channels arrive as repeated
 * `targetPlatforms` entries (checkbox group); the budget is a major-unit
 * decimal string, canonicalized to fixed-point here so the service's
 * minor-unit conversion is exact.
 */
export function parseManagedBriefForm(
  raw: Record<string, FormDataEntryValue | null | FormDataEntryValue[]>,
): ManagedBriefFormResult {
  const budgetRaw = raw.budget;
  const budgetString =
    typeof budgetRaw === "string" ? budgetRaw.trim() : String(budgetRaw ?? "");

  // Canonicalize to a plain decimal with exactly 2 places (or none) so the
  // fixed-point parse in the service is deterministic.
  const budgetCanonical = /^-?\d+(\.\d+)?$/.test(budgetString)
    ? Number(budgetString).toFixed(2)
    : budgetString;

  const platformsRaw = raw.targetPlatforms;
  const targetPlatforms = Array.isArray(platformsRaw)
    ? platformsRaw.filter((entry): entry is string => typeof entry === "string")
    : typeof platformsRaw === "string" && platformsRaw !== ""
      ? [platformsRaw]
      : [];

  const parsed = managedBriefSchema.safeParse({  // form → schema input
    campaignGoal: raw.campaignGoal,
    description: raw.description,
    budget: budgetCanonical,
    currency: typeof raw.currency === "string" ? raw.currency : "",
    targetAudience: raw.targetAudience,
    targetPlatforms,
    creatorRequirements:
      typeof raw.creatorRequirements === "string"
        ? raw.creatorRequirements
        : "",
  });

  if (!parsed.success) {
    const fieldErrors = flattenFieldErrors(parsed.error);

    // Zod reports a bad checkbox entry at "targetPlatforms.0"; the form (and
    // tests) key errors on the GROUP name. Collapse element keys onto it so a
    // single invalid channel highlights the checkbox group as a whole.
    for (const key of Object.keys(fieldErrors)) {
      if (/^targetPlatforms\.\d+$/.test(key)) {
        fieldErrors.targetPlatforms = [
          ...(fieldErrors.targetPlatforms ?? []),
          ...(fieldErrors[key] ?? []),
        ];
        delete fieldErrors[key];
      }
    }

    return { success: false, fieldErrors };
  }

  return { success: true, data: parsed.data };
}

/**
 * Agenda Managed (V1, slice 3) — support sourcing candidates.
 *
 * MINIMAL by the same rule as the slice 2 review schema: the client may
 * identify WHICH brief/candidate to act on plus the (optional) internal note,
 * and nothing more. There is NO status field in any of these schemas — the
 * transition target is decided entirely by the server's state machine from
 * the candidate's stored status, so no client input can push a candidate into
 * any state, valid or invalid. Creator identity is never typed in: the add
 * schema takes existing record ids, and the SERVICE verifies that the account
 * actually belongs to the creator. Authorization never touches this file: it
 * is enforced by the service/action layer against the server session +
 * roster.
 */

export const managedBriefCandidateAddSchema = z.object({
  briefId: z.string().uuid("A valid brief id is required."),
  // Existing records only — identity data is referenced, never duplicated.
  creatorProfileId: z.string().uuid("Choose a creator."),
  socialAccountId: z.string().uuid("Choose one of the creator's accounts."),
  note: optionalText(1000, "Note must be 1000 characters or fewer."),
});

export type ManagedBriefCandidateAddInput = z.infer<
  typeof managedBriefCandidateAddSchema
>;

/**
 * Status change: identify the candidate and nothing else. The next status is
 * derived server-side from the stored status via
 * MANAGED_BRIEF_CANDIDATE_TRANSITIONS — same pattern as the slice 2 brief
 * review (client names the object, server owns the state machine).
 */
export const managedBriefCandidateStatusActionSchema = z.object({
  candidateId: z.string().uuid("A valid candidate id is required."),
});

export type ManagedBriefCandidateStatusActionInput = z.infer<
  typeof managedBriefCandidateStatusActionSchema
>;

/** Note update: the only writable content field, internal to support. */
export const managedBriefCandidateNoteSchema = z.object({
  candidateId: z.string().uuid("A valid candidate id is required."),
  note: optionalText(1000, "Note must be 1000 characters or fewer."),
});

export type ManagedBriefCandidateNoteInput = z.infer<
  typeof managedBriefCandidateNoteSchema
>;

export const managedBriefCandidateRemoveSchema = z.object({
  candidateId: z.string().uuid("A valid candidate id is required."),
});

export type ManagedBriefCandidateRemoveInput = z.infer<
  typeof managedBriefCandidateRemoveSchema
>;

// -------------------------------------------------------------------------
// Agenda Managed (V1, slice 4) — internal outreach tracking.
//
// Same minimal rule: forms identify the candidate (and carry an optional
// internal note). There is deliberately NO response-status field in the
// response schema — INTERESTED/DECLINED are two separate fixed actions, each
// resolved server-side, so a client can never name a raw target status that
// the server would then have to trust or re-interpret. Authorization never
// touches this file.
// -------------------------------------------------------------------------

/** Mark a candidate contacted: identify the candidate, nothing else. */
export const managedBriefOutreachContactSchema = z.object({
  candidateId: z.string().uuid("A valid candidate id is required."),
  note: optionalText(1000, "Note must be 1000 characters or fewer."),
});

export type ManagedBriefOutreachContactInput = z.infer<
  typeof managedBriefOutreachContactSchema
>;

/** Record a creator response: identify the candidate, nothing else. */
export const managedBriefOutreachResponseSchema = z.object({
  candidateId: z.string().uuid("A valid candidate id is required."),
  note: optionalText(1000, "Note must be 1000 characters or fewer."),
});

export type ManagedBriefOutreachResponseInput = z.infer<
  typeof managedBriefOutreachResponseSchema
>;

/** Update the outreach record's internal note only. */
export const managedBriefOutreachNoteSchema = z.object({
  candidateId: z.string().uuid("A valid candidate id is required."),
  note: optionalText(1000, "Note must be 1000 characters or fewer."),
});

export type ManagedBriefOutreachNoteInput = z.infer<
  typeof managedBriefOutreachNoteSchema
>;

/**
 * Agenda Managed (V1, slice 2) — support review validation.
 *
 * MINIMAL by the same rule as the Stage 13B schemas: the client may identify
 * WHICH brief to act on and nothing more. There is no status field here —
 * the transition target is decided entirely by the server's state machine
 * from the brief's stored status, so no client input can push a brief into
 * any state, valid or invalid. Authorization never touches this file: it is
 * enforced by the service/action layer against the server session + roster.
 */
export const managedBriefReviewActionSchema = z.object({
  briefId: z.string().uuid("A valid brief id is required."),
});

export type ManagedBriefReviewActionInput = z.infer<
  typeof managedBriefReviewActionSchema
>;

// -------------------------------------------------------------------------
// Agenda Managed (V1, slice 5) — conversion of a SELECTED candidate into a
// DRAFT marketplace Campaign by the brief's owning advertiser.
//
// The form carries the fields the brief does NOT contain and the Campaign
// model requires, reusing the existing campaign-form rules verbatim (the
// same title/category/location/budget/dates constraints the advertiser
// already knows from the regular campaign form). The brief's informational
// budget is deliberately NOT used: the advertiser enters the campaign budget
// explicitly, so it never silently becomes the hard cap enforced at
// acceptance time.
//
// No quote field exists here by design — the creator still authors their own
// quoteAmount through the normal application flow, and no rate is derived
// from any rate card.
// -------------------------------------------------------------------------

export const managedBriefConversionSchema = z.object({
  briefId: z.string().uuid("A valid brief id is required."),
  candidateId: z.string().uuid("A valid candidate id is required."),
  // Reuse the EXACT campaign-form field rules so conversion cannot create a
  // campaign the normal flow would refuse.
  title: z
    .string()
    .trim()
    .min(3, { message: "Enter a campaign title." })
    .max(120, { message: "Title must be 120 characters or fewer." }),
  category: z.enum(categoryEnumValues, { message: "Choose a category." }),
  targetLocation: z
    .string()
    .trim()
    .min(2, { message: "Enter the location you're targeting." })
    .max(100, { message: "Target location is too long." }),
  minimumFollowers: z.coerce
    .number({ message: "Enter a number." })
    .int({ message: "Minimum followers must be a whole number." })
    .min(0, { message: "Minimum followers cannot be negative." })
    .max(1_000_000_000, { message: "Minimum followers is too large." }),
  maxCreators: z.coerce
    .number({ message: "Enter a number." })
    .int({ message: "Creator slots must be a whole number." })
    .min(1, { message: "At least one creator can be accepted." })
    .max(50, { message: "At most 50 creator slots are supported." })
    .default(1),
  // The advertiser enters the campaign budget EXPLICITLY — the brief's
  // informational budget is never silently promoted into the hard cap.
  budget: z.coerce
    .number({ message: "Enter a budget." })
    .positive({ message: "Budget must be greater than zero." })
    .max(1_000_000_000_000, { message: "Budget is too large." }),
  contentRequirements: optionalText(
    2000,
    "Content requirements must be 2000 characters or fewer.",
  ),
  rules: optionalText(2000, "Rules must be 2000 characters or fewer."),
});

export type ManagedBriefConversionInput = z.infer<
  typeof managedBriefConversionSchema
>;

/** Parse a date-only form input ("2026-10-31") to end-of-day UTC, or null. */
function parseConversionDateField(value: FormDataEntryValue | null): Date | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  const date = new Date(`${value.trim()}T23:59:59.999Z`);

  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Validate a conversion payload from FormData. Cross-field date rules mirror
 * parseCampaignForm so a converted draft obeys the same structural rules as
 * a regular draft (deadline on/before end date, start on/before end).
 */
export type ManagedBriefConversionFormResult =
  | { success: true; data: ManagedBriefConversionInput & { startDate: Date | null; endDate: Date | null; applicationDeadline: Date | null } }
  | { success: false; fieldErrors: Record<string, string[]> };

export function parseManagedBriefConversionForm(
  raw: Record<string, FormDataEntryValue | null>,
): ManagedBriefConversionFormResult {
  const parsed = managedBriefConversionSchema.safeParse({
    briefId: raw.briefId,
    candidateId: raw.candidateId,
    title: raw.title,
    category: raw.category,
    targetLocation: raw.targetLocation,
    minimumFollowers: raw.minimumFollowers,
    maxCreators: raw.maxCreators,
    budget: raw.budget,
    contentRequirements: raw.contentRequirements ?? "",
    rules: raw.rules ?? "",
  });

  if (!parsed.success) {
    return { success: false, fieldErrors: flattenFieldErrors(parsed.error) };
  }

  const startDate = parseConversionDateField(raw.startDate ?? null);
  const endDate = parseConversionDateField(raw.endDate ?? null);
  const applicationDeadline = parseConversionDateField(raw.applicationDeadline ?? null);
  const fieldErrors: Record<string, string[]> = {};

  if (startDate && endDate && startDate.getTime() > endDate.getTime()) {
    (fieldErrors.startDate ??= []).push(
      "Start date must be on or before the end date.",
    );
  }

  if (
    applicationDeadline &&
    endDate &&
    applicationDeadline.getTime() > endDate.getTime()
  ) {
    (fieldErrors.applicationDeadline ??= []).push(
      "The application deadline must be on or before the campaign end date.",
    );
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { success: false, fieldErrors };
  }

  return {
    success: true,
    data: { ...parsed.data, startDate, endDate, applicationDeadline },
  };
}
