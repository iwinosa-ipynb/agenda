import { z } from "zod";

import { MANAGED_BRIEF_CHANNELS } from "@/lib/constants";
import { flattenFieldErrors } from "@/validation/errors";

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
