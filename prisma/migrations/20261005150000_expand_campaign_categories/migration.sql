-- Expand the campaign category taxonomy.
--
-- ADDITIVE ONLY. Five categories are appended to the existing "Category" enum:
-- WEB3, POLITICS, HEALTH, BUSINESS, ENTERTAINMENT.
--
-- No existing value is renamed and none is removed, so:
--   * every existing Campaign.category and CreatorProfile.category row keeps
--     working untouched and no data migration is required;
--   * CreatorProfile.category stays nullable and is NOT made required here;
--   * TECH keeps its enum value; only its human-readable label changes, and
--     that lives in code (src/lib/constants.ts), not in the database.
--
-- ALTER TYPE ... ADD VALUE is additive and cannot drop or rewrite stored data.

ALTER TYPE "Category" ADD VALUE 'WEB3';
ALTER TYPE "Category" ADD VALUE 'POLITICS';
ALTER TYPE "Category" ADD VALUE 'HEALTH';
ALTER TYPE "Category" ADD VALUE 'BUSINESS';
ALTER TYPE "Category" ADD VALUE 'ENTERTAINMENT';
