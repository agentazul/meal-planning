# Done For You Kitchen

Done For You Kitchen is a self-hosted household meal planner built around one idea:

```text
true weekly cost = what you buy - what has a real chance of carrying forward
```

This repository contains the working Phase 1 foundation, a prompt-free AI weekly planner, a focused custom recipe workshop, and the first Phase 2 kitchen-inventory slice. It is a React Router 8 framework-mode application with strict TypeScript, PostgreSQL, Drizzle ORM, Tailwind CSS, email magic-link authentication, Vercel AI Gateway, and household-scoped server access.

## Current scope

Implemented:

- Two adult users with full access to one household through single-use email magic links
- Configurable household members with appetite multipliers and stable seed identities
- Per-member Usually home or Usually away baselines, plain-language repeating schedules, and direct exact-date changes
- Sunday-to-Saturday week planning with computed dinner serving targets
- Manual recipe entry and recipe display in US customary cooking units, with canonical conversions kept internal
- Prompt-free AI weekly drafting with a 21-day repeat-avoidance window, same-page five-dinner review, live combined ingredients, two free per-night shuffles, and full instructions only after acceptance
- Optional one-off AI recipe drafting from a custom brief
- One household-scoped markdown preference document that guides every weekly generation call, with a safe starter profile and updater audit trail
- Recipe scheduling, replacement, deliberate leftovers, and removal
- Exactly 300 canonical ingredients and one default purchase format per ingredient
- Durable household pantry counts with inline weekly inventory controls, package-fit decisions before shopping, a complete generated shopping checklist, native Apple Notes checklist output through Shortcuts, manual correction for off-plan use, and a reviewed grocery-restock batch that accepts package defaults or actual amounts bought
- PostgreSQL schema, generated Drizzle migration, operator rollback, and idempotent seed command
- Household-scoped queries and mutations, request logging, database-backed sessions, and event logging
- Responsive desktop and phone layouts

Deferred by the requested build order:

- Remaining Phase 2 allocation, persisted shopping checkoffs, Kroger, Instacart, reconciliation, inventory lots, and offline PWA caches
- Phase 3 carryover valuation, cost explanations, scoring, and expiry surfacing
- Phase 4 pantry-aware and cost-aware weekly scoring, bench meals, swaps, ratings, and rotation

The PWA cache remains deferred because its durable offline contract needs a checkable shopping workflow plus the current week's recipes. The current generated list is derived after each saved count and can create a native Apple Notes checklist through a synced Shortcut, but does not claim in-app persisted checkoffs. The Groceries are home action is an explicit pantry update from a reviewed set of purchases, not a persisted shopping list, receipt, inventory lot, or automatic retailer reconciliation.

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

   Replace the database URLs, create a unique secret of at least 32 characters, and configure the household member profile JSON. Keep `MAGIC_LINK_DELIVERY=console` only for local development. `AI_RECIPE_MODEL` defaults to `google/gemini-3.7-flash` through Vercel AI Gateway.

   A linked Vercel project can instead use `vercel env pull .env.local --environment=development`. Standalone migration and Drizzle commands load `.env.local` first and then use `.env` for missing values. The seed also checks an ignored `.env.seed.local` first so real household profiles can stay separate from runtime configuration.

3. Apply the schema and seed the household plus ingredient reference data.

   ```bash
   npm run db:migrate
   npm run db:seed
   ```

   The seed command is safe to run again. It updates the canonical manifest and default purchase formats without duplicating the household, users, members, or ingredients. Set `HOUSEHOLD_SEED_DRY_RUN=true` to execute the full seed transaction and roll it back intentionally before the first production apply.

   `HOUSEHOLD_MEMBER_PROFILES_JSON` is the preferred member configuration. Each strict profile supplies `seedKey`, `displayName`, `email`, `memberType`, and `appetiteMultiplier`. Exactly two adult profiles must have distinct login emails. Keep every non-login member's `seedKey` stable: it is part of that member's deterministic database identity, so changing it creates a different member instead of renaming the existing one. `HOUSEHOLD_ADULT_EMAILS` remains available as the four-person legacy fallback when profile JSON is blank.

4. Start the development server.

   ```bash
   npm run dev
   ```

5. Open `http://localhost:5173`. Request a link for one of the two seeded adult emails. In console delivery mode, the sign-in screen exposes a development-only preview link. The link opens a confirmation screen and is consumed only after confirmation.

## Apple Notes shortcut

The pantry page can copy the generated rows and launch the `Done For You Kitchen Shopping List` Shortcut. Configure that Shortcut to receive input from nowhere and set `If there’s no input` to `Get Clipboard`. It should split `Shortcut Input` by new lines, create the shopping-list note, and append each split row as a checklist item. The payload places each uppercase category divider on its own row, followed by compact `Ingredient: package` rows without recipe quantities or shopping-status labels. When one package is not enough, the row includes the whole-package count needed to cover the shortage. A saved alternate store amount is preserved exactly, so a decision such as `2 large lemons` replaces the catalog's `2 lb bag`; the two are not treated as aliases. Apple Notes' Shortcut action adds a checklist circle to every appended row, so category dividers also have circles; the output does not claim mixed plain headings and checklist items.

Keep the Shortcut in iCloud. It then syncs to the household's signed-in Apple devices, so each device does not need a separately rebuilt automation. The web app intentionally launches a short URL without the list payload; the Shortcut reads the copied rows from the local device clipboard instead.

## Package-fit review

Before the final list can be exported or restocked, every weekly ingredient must have a saved pantry count; an unknown amount, including an optional one, is never turned into a package recommendation. `/pantry/package-fit` then surfaces material gaps between a recipe need and the available store package. Each conflict requires an explicit choice: permanently update a saved recipe, keep the recipe and buy enough whole packages, or enter a different store amount. Saved store decisions keep the exact label, quantity, and unit for both Apple Notes and the post-shopping pantry update. They are household- and meal-plan-scoped and become stale automatically if the recipe demand, pantry count, default package basis, or item conversion basis changes.

A recipe edit is intentionally permanent rather than a current-week override. It updates the saved ingredient quantity and all method steps in one transaction, so every plan using that recipe, including previously planned weeks, sees the change. The form requires an explicit acknowledgement, shows serving impact, never preselects protein or method-sensitive reductions, uses optimistic concurrency, and writes an audit event.

## Grocery restock review

After shopping, open Groceries are home on the pantry page. Every derived shopping row is selected with enough whole default packages to cover the shortage: `ceil(shortage / default package quantity)`. The package count shown on the shopping list is the exact package count that the default restock adds. Uncheck anything not purchased, or open Bought something different? to enter the amount and unit actually brought home. For example, `2 count` lemons uses the catalog's average grams-per-lemon conversion instead of the default bag quantity. An audible adds the actual entered amount, and any remaining shortage stays visible on the derived shopping list.

Known pantry balances add the reviewed purchase. For an ingredient that was not counted before the trip, the safe default treats the purchase as the total now on hand; choose Add only when food was already present and its amount is intentionally included. The selected rows apply in one transaction and write one bounded audit event. A durable batch ID makes an identical submission idempotent, but the batch is not a receipt, lot, checkoff, or purchase-history model.

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
| `npm run db:seed` | Seed configured household profiles and the 300-ingredient manifest |
| `npm run db:studio` | Open Drizzle Studio against the configured database |

## Vercel and Neon

The application is linked to `xsqrd/meal-planning`, deployed on Vercel, and connected to the free-tier `meal-planning-db` Neon resource. Production also requires an HTTPS origin, a unique session secret, authenticated SMTP delivery from a verified sender domain, and project OIDC enabled for Vercel AI Gateway.

- Use a pooled Neon URL for `DATABASE_URL` at runtime.
- Use Neon's injected `DATABASE_URL_UNPOOLED` during migrations. `DATABASE_DIRECT_URL` remains a supported provider-neutral override.
- Configure the required runtime variables and applicable SMTP variables in Vercel. The Vercel Resend integration's `RESEND_API_KEY` can serve as the SMTP password. Keep household profile JSON and all other seed variables in the trusted operator environment that runs the seed. Production requires SMTP delivery and an HTTPS `APP_ORIGIN`.
- Keep `AI_RECIPE_MODEL` fixed to an approved Gateway model. The default `google/gemini-3.7-flash` route uses Vercel project OIDC and does not require a provider API key in the application.
- Apply migrations and run the one-time seed from a trusted operator environment before serving production traffic.
- Let Vercel detect React Router from the project. The Vercel React Router preset is intentionally not installed while its published peer range remains React Router 7 only.

See [Phase 1 operations](docs/phase-1-operations.md) for the complete setup, release, rollback, and secret-handling checklist.

## Architecture and safety

[Architecture](docs/architecture.md) describes request context, household isolation, presence resolution, serving calculations, pantry counts, and schema ownership.

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
