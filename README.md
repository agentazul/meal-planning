# Kitchen Ledger

Kitchen Ledger is a self-hosted household meal planner built around one idea:

```text
true weekly cost = what you buy - what has a real chance of carrying forward
```

This repository contains the working Phase 1 foundation. It is a React Router 8 framework-mode application with strict TypeScript, PostgreSQL, Drizzle ORM, Tailwind CSS, email magic-link authentication, and household-scoped server access.

## Phase 1 scope

Implemented:

- Two adult users with full access to one household through single-use email magic links
- Four configurable household members with appetite multipliers
- Generic presence rules using iCalendar RRULE data, priority resolution, and exact-date overrides
- Sunday-to-Saturday week planning with computed dinner serving targets
- Manual recipe entry using canonical ingredient and base-unit conversions
- Recipe scheduling, replacement, deliberate leftovers, and removal
- Exactly 300 canonical ingredients and one default purchase format per ingredient
- PostgreSQL schema, generated Drizzle migration, operator rollback, and idempotent seed command
- Household-scoped queries and mutations, request logging, database-backed sessions, and event logging
- Responsive desktop and phone layouts

Deferred by the requested build order:

- Phase 2 pantry, allocation, shopping list, Kroger, Instacart, reconciliation, and offline PWA caches
- Phase 3 carryover valuation, cost explanations, scoring, and expiry surfacing
- Phase 4 Anthropic recipe generation, preference editor, bench meals, swaps, ratings, and rotation

The PWA cache is intentionally deferred to Phase 2 because its required offline payload is the active shopping list plus the current week's recipes. Phase 1 does not create a partial cache contract that Phase 2 would need to replace.

## Requirements

- Node.js 22.22.0 or newer
- npm 10.9.8 or compatible
- PostgreSQL 15 or newer, including Neon Postgres

The project pins React Router 8.3.0, React 19.2.8, Vite 8.2.1, and all other direct dependencies to exact versions.

## Local setup

1. Install dependencies.

   ```bash
   npm install
   ```

2. Create local environment configuration.

   ```bash
   cp .env.example .env
   ```

   Replace the database URLs, create a unique secret of at least 32 characters, and set the two real adult email addresses. Keep `MAGIC_LINK_DELIVERY=console` only for local development.

   A linked Vercel project can instead use `vercel env pull .env.local --environment=development`. Standalone migration, seed, and Drizzle commands load `.env.local` first and then use `.env` for missing values.

3. Apply the schema and seed the household plus ingredient reference data.

   ```bash
   npm run db:migrate
   npm run db:seed
   ```

   The seed command is safe to run again. It updates the canonical manifest and default purchase formats without duplicating the household, users, members, or ingredients.

4. Start the development server.

   ```bash
   npm run dev
   ```

5. Open `http://localhost:5173`. Request a link for one of the two seeded adult emails. In console delivery mode, the sign-in screen exposes a development-only preview link. The link opens a confirmation screen and is consumed only after confirmation.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the React Router development server |
| `npm run build` | Create the production SSR build |
| `npm run start` | Run the built app with React Router Serve |
| `npm run typecheck` | Generate route types and run strict TypeScript |
| `npm test` | Run deterministic domain, security, persistence, and component tests |
| `npm run check:copy` | Reject em dashes and en dashes in product text |
| `npm run check` | Run copy, type, test, and production build gates |
| `npm run db:generate` | Generate a migration from Drizzle schema changes |
| `npm run db:migrate` | Apply committed migrations |
| `npm run db:seed` | Seed the household and 300-ingredient manifest |
| `npm run db:studio` | Open Drizzle Studio against the configured database |

## Vercel and Neon

The application is linked to `xsqrd/meal-planning`, deployed on Vercel, and connected to the free-tier `meal-planning-db` Neon resource. The production deployment remains protected and is not ready for household use until SMTP, the session secret, origin configuration, and the one-time production seed are complete.

- Use a pooled Neon URL for `DATABASE_URL` at runtime.
- Use Neon's injected `DATABASE_URL_UNPOOLED` during migrations. `DATABASE_DIRECT_URL` remains a supported provider-neutral override.
- Configure the required runtime variables and applicable SMTP variables in Vercel. Keep the household seed variables in the trusted operator environment that runs the seed. Production requires SMTP delivery and an HTTPS `APP_ORIGIN`.
- Apply migrations and run the one-time seed from a trusted operator environment before serving production traffic.
- Let Vercel detect React Router from the project. The Vercel React Router preset is intentionally not installed while its published peer range remains React Router 7 only.

See [Phase 1 operations](docs/phase-1-operations.md) for the complete setup, release, rollback, and secret-handling checklist.

## Architecture and safety

[Architecture](docs/architecture.md) describes request context, household isolation, presence resolution, serving calculations, and schema ownership.

Important safeguards:

- Runtime requests receive a request-local PostgreSQL client and close it after the response.
- Root middleware resolves the session and places a branded household scope in typed React Router context.
- Authenticated loaders and actions can only obtain a scoped database handle from that context.
- Session and magic-link values are random 256-bit tokens stored only as SHA-256 hashes.
- Magic links are single-use, expire after 15 minutes, and are consumed by POST after an explicit confirmation.
- Production cookies are HTTP-only, secure, host-only, and backed by revocable database sessions.
- Canonical quantities are persisted as exact numerics in grams, milliliters, or counts.
- Calendar dates stay as date-only values, so presence does not shift with a server timezone.

Never commit `.env`, browser automation output, database dumps, or generated sign-in URLs.
