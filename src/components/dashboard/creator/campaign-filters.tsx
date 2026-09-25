import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/field";
import { CATEGORY_LABELS, PLATFORM_LABELS } from "@/lib/constants";
import type { CampaignFilters as CampaignFilterValues } from "@/validation/campaign";

const FOLLOWER_OPTIONS = [
  { value: "1000", label: "1K+" },
  { value: "10000", label: "10K+" },
  { value: "50000", label: "50K+" },
  { value: "100000", label: "100K+" },
  { value: "500000", label: "500K+" },
  { value: "1000000", label: "1M+" },
];

const BUDGET_OPTIONS = [
  { value: "50000", label: "₦50,000+" },
  { value: "100000", label: "₦100,000+" },
  { value: "300000", label: "₦300,000+" },
  { value: "500000", label: "₦500,000+" },
  { value: "1000000", label: "₦1,000,000+" },
];

const SORT_OPTIONS = [
  { value: "newest", label: "Newest" },
  { value: "budget", label: "Biggest budget" },
  { value: "deadline", label: "Closing soon" },
];

/**
 * Filters submit as a normal GET request, so the selected values end up in the
 * URL and the database does the filtering.
 */
export function CampaignFilters({
  filters,
}: {
  filters: CampaignFilterValues;
}) {
  return (
    <Card className="p-5">
      <form method="get" action="/dashboard/campaigns" className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="sm:col-span-2 lg:col-span-1">
            <Field label="Search" htmlFor="q">
              <Input
                id="q"
                name="q"
                type="search"
                defaultValue={filters.q ?? ""}
                placeholder="Campaign or brand"
              />
            </Field>
          </div>

          <Field label="Platform" htmlFor="platform">
            <Select
              id="platform"
              name="platform"
              defaultValue={filters.platform ?? ""}
            >
              <option value="">All platforms</option>
              {Object.entries(PLATFORM_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Category" htmlFor="category">
            <Select
              id="category"
              name="category"
              defaultValue={filters.category ?? ""}
            >
              <option value="">All categories</option>
              {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Location" htmlFor="location">
            <Input
              id="location"
              name="location"
              defaultValue={filters.location ?? ""}
              placeholder="e.g. Lagos"
            />
          </Field>

          <Field label="Minimum followers" htmlFor="minFollowers">
            <Select
              id="minFollowers"
              name="minFollowers"
              defaultValue={filters.minFollowers?.toString() ?? ""}
            >
              <option value="">Any</option>
              {FOLLOWER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Budget" htmlFor="minBudget">
            <Select
              id="minBudget"
              name="minBudget"
              defaultValue={filters.minBudget?.toString() ?? ""}
            >
              <option value="">Any</option>
              {BUDGET_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Sort by" htmlFor="sort">
            <Select id="sort" name="sort" defaultValue={filters.sort ?? "newest"}>
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="sm">
            Apply filters
          </Button>
          <Link
            href="/dashboard/campaigns"
            className="text-sm text-ink-soft underline-offset-4 hover:text-ink hover:underline"
          >
            Clear
          </Link>
        </div>
      </form>
    </Card>
  );
}
