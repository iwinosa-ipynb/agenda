import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { CATEGORY_LABELS } from "@/lib/constants";
import { Category } from "@/generated/prisma/enums";

/**
 * Category taxonomy contract.
 *
 * The taxonomy has ONE source of truth — the Prisma `Category` enum — and every
 * UI reads its display labels from CATEGORY_LABELS. These tests pin both halves
 * so a future edit cannot silently drop a category, leave one without a label,
 * or reintroduce raw enum values (FASHION, TECH) into a user-facing dropdown.
 */

const CONVERSION_FORM = readFileSync(
  new URL(
    "../components/dashboard/advertiser/managed-brief-conversion-form.tsx",
    import.meta.url,
  ),
  "utf8",
);

/** The 19 categories Agenda supports, in canonical order. */
const EXPECTED_CATEGORIES = [
  "FASHION",
  "BEAUTY",
  "FITNESS",
  "TECH",
  "GAMING",
  "FOOD",
  "TRAVEL",
  "LIFESTYLE",
  "COMEDY",
  "MUSIC",
  "SPORTS",
  "EDUCATION",
  "FINANCE",
  "WEB3",
  "POLITICS",
  "HEALTH",
  "BUSINESS",
  "ENTERTAINMENT",
  "OTHER",
] as const;

/** The five categories added when the taxonomy was expanded. */
const NEW_CATEGORIES = ["WEB3", "POLITICS", "HEALTH", "BUSINESS", "ENTERTAINMENT"];

describe("Category taxonomy", () => {
  it("supports exactly the 19 agreed categories", () => {
    assert.deepEqual(Object.values(Category), EXPECTED_CATEGORIES);
    assert.equal(Object.keys(Category).length, 19);
  });

  it("adds Web3, Politics, Health, Business and Entertainment", () => {
    for (const category of NEW_CATEGORIES) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(Category, category),
        `Category enum must include ${category}`,
      );
    }
  });

  it("never removes or renames a pre-existing category", () => {
    // The original 14 values must all still exist under the same enum value.
    const original = [
      "FASHION",
      "BEAUTY",
      "FITNESS",
      "TECH",
      "GAMING",
      "FOOD",
      "TRAVEL",
      "LIFESTYLE",
      "COMEDY",
      "MUSIC",
      "SPORTS",
      "EDUCATION",
      "FINANCE",
      "OTHER",
    ];

    for (const category of original) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(Category, category),
        `pre-existing category ${category} must not be removed or renamed`,
      );
    }
  });

  it("gives every category a human-readable label", () => {
    assert.deepEqual(
      Object.keys(CATEGORY_LABELS).sort(),
      Object.values(Category).slice().sort(),
      "CATEGORY_LABELS must cover exactly the enum — no gaps, no extras",
    );

    for (const [value, label] of Object.entries(CATEGORY_LABELS)) {
      assert.equal(typeof label, "string");
      assert.ok(label.trim().length > 0, `${value} must have a non-empty label`);
      assert.equal(
        label,
        label.trim(),
        `${value} label must not have leading/trailing whitespace`,
      );
      assert.notEqual(
        label,
        value,
        `${value} must not display as the raw enum value`,
      );
    }
  });

  it("displays TECH as Technology without renaming the enum value", () => {
    // The enum value stays TECH so no stored data needs rewriting; only the
    // human-readable label changes.
    assert.equal(Category.TECH, "TECH");
    assert.equal(CATEGORY_LABELS.TECH, "Technology");
    assert.notEqual(CATEGORY_LABELS.TECH, "Tech");
  });

  it("labels the newly added categories for display", () => {
    assert.equal(Category.WEB3, "WEB3");
    assert.equal(CATEGORY_LABELS.WEB3, "Web3");

    assert.equal(Category.POLITICS, "POLITICS");
    assert.equal(CATEGORY_LABELS.POLITICS, "Politics");

    assert.equal(Category.HEALTH, "HEALTH");
    assert.equal(CATEGORY_LABELS.HEALTH, "Health");

    assert.equal(Category.BUSINESS, "BUSINESS");
    assert.equal(CATEGORY_LABELS.BUSINESS, "Business");

    assert.equal(Category.ENTERTAINMENT, "ENTERTAINMENT");
    assert.equal(CATEGORY_LABELS.ENTERTAINMENT, "Entertainment");
  });

  it("keeps every pre-existing label unchanged apart from TECH", () => {
    assert.equal(CATEGORY_LABELS.FASHION, "Fashion");
    assert.equal(CATEGORY_LABELS.BEAUTY, "Beauty");
    assert.equal(CATEGORY_LABELS.FITNESS, "Fitness");
    assert.equal(CATEGORY_LABELS.GAMING, "Gaming");
    assert.equal(CATEGORY_LABELS.FOOD, "Food");
    assert.equal(CATEGORY_LABELS.TRAVEL, "Travel");
    assert.equal(CATEGORY_LABELS.LIFESTYLE, "Lifestyle");
    assert.equal(CATEGORY_LABELS.COMEDY, "Comedy");
    assert.equal(CATEGORY_LABELS.MUSIC, "Music");
    assert.equal(CATEGORY_LABELS.SPORTS, "Sports");
    assert.equal(CATEGORY_LABELS.EDUCATION, "Education");
    assert.equal(CATEGORY_LABELS.FINANCE, "Finance");
    assert.equal(CATEGORY_LABELS.OTHER, "Other");
  });
});

describe("managed-brief conversion category display", () => {
  it("reads labels from the canonical CATEGORY_LABELS map", () => {
    assert.ok(
      CONVERSION_FORM.includes("CATEGORY_LABELS"),
      "the conversion form must source labels from CATEGORY_LABELS",
    );
    assert.ok(
      CONVERSION_FORM.includes("Object.entries(CATEGORY_LABELS)"),
      "the conversion form must build its options from CATEGORY_LABELS",
    );
    assert.ok(
      !/Object\.values\(Category\)/.test(CONVERSION_FORM),
      "the conversion form must not enumerate raw Category values",
    );
  });

  it("never renders a raw enum value as the option text", () => {
    // The option body must be the mapped label, not the bare enum value.
    assert.ok(
      /\{CATEGORY_OPTIONS\.map\(\(\[value, label\]\) => \([\s\S]*?<option key=\{value\} value=\{value\}>\s*\{label\}\s*<\/option>/.test(
        CONVERSION_FORM,
      ),
      "the <option> body must render {label}, not the raw enum value",
    );

    for (const raw of ["FASHION", "TECH", "LIFESTYLE", "WEB3"]) {
      assert.ok(
        !new RegExp(`>\\s*\\{category\\}\\s*<`).test(CONVERSION_FORM),
        "must not render the loop variable as raw option text",
      );
    }
  });

  it("keeps the submitted value the enum value so validation still accepts it", () => {
    // Display uses the label; the form still POSTs the enum value, which is
    // what managedBriefConversionSchema validates against.
    assert.ok(
      /<option key=\{value\} value=\{value\}>/.test(CONVERSION_FORM),
      "the option value must remain the enum value (e.g. TECH, not 'Technology')",
    );
  });
});