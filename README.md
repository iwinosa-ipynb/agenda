# Agenda

A creator advertising marketplace for Nigeria (built to expand internationally).
Brands launch campaigns and creators get paid **the fixed price they set** —
quoted per campaign, accepted by the brand, and released through confirmed
milestones.

> The **creator and advertiser sides are live**: profiles, social accounts,
> campaign marketplace, applications, agreements, funding and milestone
> payouts. Verified views are platform-checked **performance metrics** shown
> where verification has run — they are never the basis of a creator's pay.

## How creators are paid

```
creator quotes a fixed fee on a campaign (their own number, never pre-filled)
  → advertiser accepts the quote → terms are frozen into the agreement
  → advertiser funds the agreement (platform holds the money up front)
  → confirmed milestones release the agreed amounts to the creator
```

- The agreed price never changes after acceptance: later campaign edits do not
  touch a frozen agreement.
- Milestone amounts are the advertiser's explicit terms, reconciled exactly to
  the agreement total.
- CPM / price-per-1,000-views compensation is retired. The legacy
  `pricePerThousandViews` column is retained only as zeroed compatibility data
  for historical rows and is never used by any pricing logic.

## Verified views (performance metrics)

Verified views flow one way, entirely server-side:

```
platform API (official X / TikTok endpoints)
  → ownership gate (OAuth-connected platformUserId must match the post author)
  → VerificationObservation (verbatim snapshot, idempotent via observationKey)
  → high-water accounting (cumulative counts are never summed)
  → CampaignPost.verifiedViews  → campaign / creator totals → dashboard UI
```

- Metrics only exist after a real verification run; clients can never submit
  or edit them. UI shows "—" (not zero) whenever verification has not run.
- Repeated verification of the same post can never double-count: the latest
  cumulative value replaces the stored one, and a decrease keeps the previous
  high-water mark and flags the observation REVIEW (a neutral data flag —
  never fraud/bot language).
- Campaign and creator totals are recomputed from eligible verified posts by
  `src/services/verified-views-accounting.ts` (pure) and
  `src/services/verified-views.service.ts` (Prisma) — never summed in the UI.
- Ownership mismatches are the only path to REJECTED; verifier outages and
  missing connections keep posts retryable (no fake VERIFIED, no fake zeros).

### Environment variables for real verification

| Variable | Purpose |
| --- | --- |
| `X_BEARER_TOKEN` | X API v2 app-only token for post lookup (`public_metrics`, `author_id`) |
| `X_OAUTH_CLIENT_ID` / `X_OAUTH_CLIENT_SECRET` | Creator "Connect X" flow (platformUserId for ownership checks) |
| `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` | TikTok Login Kit for the creator connection flow |
| `TIKTOK_USER_ACCESS_TOKEN` | Single-tenant local-dev fallback only; production uses per-creator tokens |
| `SOCIAL_TOKEN_ENCRYPTION_KEY` | AES-256-GCM key for OAuth tokens at rest (connection fails closed without it) |
| `CRON_SECRET` | Bearer auth for `/api/cron/verify-posts` (scheduled verification) |

## Stack

- Next.js (App Router) + TypeScript + Tailwind CSS v4
- PostgreSQL + Prisma 7 (with the `pg` driver adapter)
- Auth.js (NextAuth v5) — credentials provider, JWT sessions
- Zod for input validation

## Getting started

```bash
cp .env.example .env      # then fill in DATABASE_URL and AUTH_SECRET
npm install               # runs `prisma generate` via postinstall
npm run db:migrate        # create the tables (requires a reachable database)
npm run dev
```

Generate a secret with `npx auth secret` (or `openssl rand -base64 32`).

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:generate` | Generate the Prisma client |
| `npm run db:migrate` | Create/apply a migration in development |
| `npm run db:studio` | Open Prisma Studio |

## Project structure

```
prisma/schema.prisma        Domain model (User, profiles, campaigns, posts)
prisma.config.ts            Prisma 7 config (schema + datasource URL)
src/app/                    Routes (App Router)
  (marketing)/              Public landing page + shared header/footer
  auth/                     Login + registration (+ server actions)
  dashboard/                Role-aware overview
    (creator)/              Creator-only routes, guarded server-side
      campaigns/            Marketplace + [id] detail with apply
      applications/         My applications (withdraw)
      active-campaigns/     Accepted campaigns
      social-accounts/      Add/remove claimed accounts
      profile/              Profile editing + completion
    _actions/               Server actions (private, not routable)
  api/auth/[...nextauth]/   Auth.js route handler
src/components/
  ui/                       Design-system primitives (Button, Field, Card, …)
  layout/                   Header, footer
  marketing/                Landing page sections
  auth/                     Auth forms
  dashboard/                Dashboard shell + navigation
src/lib/                    prisma client, auth config, authz guards, utils,
                            verified-view display helpers
src/services/               user + campaign services; applications, agreements,
                            funding and milestone payouts; post verification +
                            verified-view accounting
src/validation/             Zod schemas + error helpers
src/types/                  Shared types + Auth.js module augmentation
```

## Security notes

- All input is validated with Zod on the server.
- Creator pay is never taken from the client beyond their own quote: the price
  is frozen at acceptance, milestone terms are reconciled server-side in exact
  minor units, and every financial derivation happens on the server.
- Follower counts and views are treated as unverified until confirmed against a
  platform source (see `src/services/verification`).
- Authenticated routes are guarded server-side in `src/lib/authz.ts`.
- Secrets live only in `.env` (gitignored) — `.env.example` holds placeholders.
