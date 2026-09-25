# Agenda

A creator advertising marketplace for Nigeria (built to expand internationally).
Brands launch campaigns and creators earn from **verified views**.

> The **creator and advertiser sides** are built: profiles, social accounts,
> campaign marketplace, applications, active campaigns and verified-view
> accounting (Stage 9). Payments, wallets and payouts are **not implemented
> yet** — nothing displays a figure it cannot verify (verified earnings always
> read ₦0).

## Verified views (Stage 9)

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
src/services/               user + campaign services; post verification +
                            verified-view accounting (Stage 9); payments
                            interfaces (not implemented)
src/validation/             Zod schemas + error helpers
src/types/                  Shared types + Auth.js module augmentation
```

## Security notes

- All input is validated with Zod on the server.
- Payout/price amounts are never taken from the client; they are derived
  server-side from verified views and the campaign rate.
- Follower counts and views are treated as unverified until confirmed against a
  platform source (see `src/services/verification`).
- Authenticated routes are guarded server-side in `src/lib/authz.ts`.
- Secrets live only in `.env` (gitignored) — `.env.example` holds placeholders.
