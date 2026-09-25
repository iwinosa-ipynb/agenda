import { z } from "zod";

import { Category } from "@/generated/prisma/client";
import { CAMPAIGN_PLATFORMS } from "@/lib/constants";
import { flattenFieldErrors } from "@/validation/errors";

const categoryValues = Object.values(Category) as [Category, ...Category[]];

const campaignPlatformValues = [
  ...CAMPAIGN_PLATFORMS,
] as [
  (typeof CAMPAIGN_PLATFORMS)[number],
  ...(typeof CAMPAIGN_PLATFORMS)[number][],
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

/** Optional URL field: trims and treats an empty string as absent. */
function optionalUrl(max: number) {
  return z
    .union([z.url({ message: "Enter a valid URL." }).max(max), z.literal("")])
    .transform((value) => (value === "" ? undefined : value))
    .optional();
}

export const advertiserProfileSchema = z.object({
  companyName: z
    .string()
    .trim()
    .min(2, { message: "Enter your company name." })
    .max(100, { message: "Company name is too long." }),
  companyDescription: optionalText(
    1000,
    "Company description must be 1000 characters or fewer.",
  ),
  location: optionalText(100, "Location is too long."),
  state: optionalText(100, "State is too long."),
  country: optionalText(100, "Country is too long."),
  website: optionalUrl(300),
  logoUrl: optionalUrl(500),
});

export type AdvertiserProfileInput = z.infer<typeof advertiserProfileSchema>;

/**
 * Campaign form: structural fields only. Dates are parsed separately below so
 * the write path receives real Date objects instead of raw strings.
 */
const campaignFormSchema = z.object({
  title: z
    .string()
    .trim()
    .min(3, { message: "Enter a campaign title." })
    .max(120, { message: "Title must be 120 characters or fewer." }),
  description: z
    .string()
    .trim()
    .min(20, { message: "Describe the campaign in at least 20 characters." })
    .max(5000, { message: "Description must be 5000 characters or fewer." }),
  category: z.enum(categoryValues, { message: "Choose a category." }),
  platform: z.enum(campaignPlatformValues, {
    message: "Choose a supported platform.",
  }),
  targetCountry: optionalText(100, "Target country is too long."),
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
  // Stage 12: how many creators may be accepted. Defaults to one; the
  // advertiser can raise it for multi-creator campaigns (budget permitting).
  maxCreators: z.coerce
    .number({ message: "Enter a number." })
    .int({ message: "Creator slots must be a whole number." })
    .min(1, { message: "At least one creator can be accepted." })
    .max(50, { message: "At most 50 creator slots are supported." })
    .default(1),
  // Optional free-text tags beyond the primary category.
  tags: z
    .string()
    .trim()
    .max(200, { message: "Tags are too long." })
    .transform((value) =>
      value === ""
        ? ([] as string[])
        : value
            .split(",")
            .map((tag) => tag.trim())
            .filter((tag) => tag.length > 0 && tag.length <= 30)
            .slice(0, 10),
    )
    .optional()
    .default(() => [] as string[]),
  // Coerced from string input, then checked as a positive number. Numbers are
  // written to Decimal columns via fixed-point strings in the service layer.
  // Stage 12: the CPM rate field is retired — compensation comes from the
  // accepted creator quote, so only the budget remains advertiser-controlled.
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

export type CampaignFormInput = z.infer<typeof campaignFormSchema>;

export type ParsedCampaignDates = {
  startDate: Date | null;
  endDate: Date | null;
  applicationDeadline: Date | null;
};

/** Everything the service needs to create or update a campaign. */
export type CampaignWriteInput = CampaignFormInput & ParsedCampaignDates;

/**
 * Parse a date-only form input ("2026-10-31") into an end-of-day UTC Date.
 * An empty or missing value becomes null (field not set). End-of-day keeps
 * "deadline equals end date" valid and gives applicants the full final day.
 */
function parseDateField(value: FormDataEntryValue | null): Date | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  const date = new Date(`${value.trim()}T23:59:59.999Z`);

  return Number.isNaN(date.getTime()) ? null : date;
}

export type CampaignFormResult =
  | { success: true; data: CampaignWriteInput }
  | { success: false; fieldErrors: Record<string, string[]> };

/**
 * Validate a campaign form payload. Cross-field date rules are structural, so
 * they apply to drafts and published campaigns alike; lifecycle and ownership
 * checks happen in the service layer.
 */
export function parseCampaignForm(
  raw: Record<string, FormDataEntryValue | null>,
  intent: "draft" | "publish" = "publish",
): CampaignFormResult {
  const schema =
    intent === "draft"
      ?        // Drafts only need the fields the database requires to exist. Money
        // and copy can be filled in later; publishing re-validates everything.
        campaignFormSchema.extend({
          description: z.string().trim().max(5000).default(""),
          budget: z.coerce.number().min(0).max(1_000_000_000_000).default(0),
        })
      : campaignFormSchema;

  const parsed = schema.safeParse(raw);

  if (!parsed.success) {
    return { success: false, fieldErrors: flattenFieldErrors(parsed.error) };
  }

  const startDate = parseDateField(raw.startDate ?? null);
  const endDate = parseDateField(raw.endDate ?? null);
  const applicationDeadline = parseDateField(raw.applicationDeadline ?? null);
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
