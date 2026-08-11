# Current architecture

## Product boundary

The application supports this household workflow:

1. A seeded adult requests and confirms a single-use magic link.
2. The adult defines recurring presence or an exact-date exception for any household member.
3. The adult maintains one shared kitchen preference document for allergies, dislikes, flavors, equipment, and weeknight limits.
4. The adult asks the weekly planner for a prompt-free five-dinner draft based on presence, serving targets, preferences, the prior 21 days of planned or cooked meals, and the canonical catalog.
5. The adult reviews or rerolls each proposed dinner, then accepts the set to create complete recipes and schedule all five dates atomically.
6. Manual entry and a one-off custom AI recipe workshop remain available for individual recipes.
7. The week view derives each serving target from the people who are home and any deliberate leftovers.
8. The pantry view turns a selected week's planned recipe ingredients into a focused first inventory, then lets either adult correct the actual amount after off-plan use or restocking.

Pantry counts are active. Allocation, shopping, delivery, reconciliation, inventory lots, carryover value, bench meals, and swaps are later phases. The current weekly generator scores validated candidates for variety and useful non-staple ingredient overlap. It does not yet claim pantry-aware cost optimization, zero-store behavior, or bench selection.

## Request flow

Every framework request passes through root middleware before a route loader or action runs.

```text
HTTP request
  -> request-local postgres client
  -> database session resolution
  -> typed RouterContext identity and branded household scope
  -> route loader or action
  -> household-scoped data helper
  -> response with request ID and timing
  -> postgres client close
```

`app/server/request-context.server.ts` owns request logging, the request database lifetime, and session resolution. `app/server/context.server.ts` owns the typed contexts and the only function that creates a `ScopedDatabase` for authenticated code.

The scope is branded in TypeScript and contains `householdId` plus `userId`. Data helpers accept this scope and include the household ID in reads, writes, and conflict targets. Foreign keys also repeat household ownership where a cross-household relationship must be impossible.

## Authentication

The auth design is intentionally small for two adult users:

- The seed command creates two active application users and household memberships from `HOUSEHOLD_ADULT_EMAILS`.
- Sign-in always returns a generic success response, including for an unknown email.
- A known user receives a random single-use token that expires after 15 minutes.
- Only a SHA-256 hash is stored in PostgreSQL.
- The link opens a no-store confirmation page. A POST consumes it atomically and creates a random database-backed session.
- The session cookie is HTTP-only and `SameSite=Lax`. Production also requires `Secure` and uses the `__Host-` prefix.
- Every unsafe request must come from the configured application origin.
- Session resolution enforces absolute expiry, idle expiry, revocation, active user state, and current household membership.

Console delivery is restricted to non-production development. Production environment validation requires SMTP and HTTPS.

## Presence model

Presence is generic rather than tied to one family schedule.

Each active member defaults to present. Resolution for one member and one date is:

1. Use the exact-date override when one exists.
2. Otherwise evaluate matching recurrence rules by descending numeric priority.
3. Use the first matching rule's present or absent effect.
4. Otherwise keep the default of present.

Rules store an iCalendar RRULE string plus an effective date range. Common weekly and every-two-weeks patterns have form controls, and an advanced RRULE field supports patterns outside those controls. Date-only Temporal values keep behavior stable across server timezones and daylight-saving changes.

A successful member, rule, or override mutation refreshes persisted serving targets for future planned entries. The week loader still recalculates the displayed target from current presence so a stale stored value cannot mislead the user.

## Kitchen preference profile

`/preferences` is a real markdown editor for one shared household document. A safe starter profile prompts adults to record allergies, medical dietary needs, individual spice and texture preferences, equipment, weeknight limits, protein rotation, desired cuisines, and hard nos. The starter is returned without a write until an adult explicitly saves it.

The persisted row is keyed by household, records the scoped application user who last updated it, and is replaced through an atomic upsert. Both the request boundary and PostgreSQL enforce a nonblank 12,000-character maximum and reject long dash characters. The audit event records only the updater and character count, never the document text.

The profile is included as untrusted preference context in every weekly candidate call. Dietary notes are sent separately without member names or identifiers. The optional one-recipe workshop keeps its explicit custom brief so it can remain a targeted tool rather than the primary planning flow.

## Serving calculation

For a scheduled date:

```text
demand = sum of appetite multipliers for members who are present
servings target = ceiling of demand + deliberate leftover servings
```

The calculation is a pure function in `app/domain/servings.ts`. Appetite multipliers remain exact decimal values at the database boundary, then become finite numbers inside the domain calculation. A zero-person day is shown and persisted as zero unless deliberate leftovers create demand, so the planner remains consistent when presence changes after scheduling.

## Ingredients and units

Canonical ingredients are global reference data. Household data never changes their identity.

Each ingredient records:

- category, base unit, storage class, and shelf life
- sealed and opened survival assumptions
- density or grams per count when a conversion needs it
- staple status and aliases
- one seeded default purchase format with quantity and typical price

The checked-in manifest contains exactly 300 unique ingredients across produce, protein, dairy, pantry, spice, frozen, bakery, and other categories. The seed is deterministic and idempotent.

## Pantry inventory

`/pantry` maintains one current count per household and canonical ingredient. Each row preserves the amount and US kitchen unit entered by the adult, the equivalent canonical quantity in grams, milliliters, or count, the updating user, and timestamps. A zero row means the ingredient was counted and is empty. No row means it has not been counted, so the UI never mistakes unknown inventory for zero inventory.

The selected week's checklist reads only planned meal entries, scales linear recipe ingredients from base servings to the stored serving target, keeps non-linear quantities at one recipe amount, and aggregates repeated ingredients. Optional-only ingredients stay visibly optional. The comparison is a read model: it reports uncounted, below-plan, or covered inventory without reserving or subtracting anything.

Every inventory save is an absolute count and an atomic household-scoped upsert. This makes a repeated form submission converge on the same number and gives adults a direct way to record sandwich ingredients, spills, restocking, or any other off-plan change. The mutation also writes a bounded `pantry.item_counted` audit event. Scheduling or removing a recipe never changes pantry quantity.

This first inventory slice deliberately does not model packages, lots, opened dates, expiry, receipts, recipe consumption, or shopping reconciliation. Those workflows need explicit state transitions and should not be inferred from a plan entry.

Household recipe entry, AI output, review screens, and saved recipe pages use US customary cooking units. `app/domain/units.ts` converts those amounts to grams, milliliters, or counts for internal persistence and arithmetic. Legacy metric recipe rows are converted at presentation time instead of being destructively rewritten. Conversions that need missing density or per-count metadata fail at the input boundary instead of storing an invented value.

## AI weekly planner and custom workshop

`/plans/:weekStart/generate` is the primary prompt-free generation path:

1. The server derives five dinner slots from presence demand, exact serving targets, and weekday or weekend effort limits. The browser cannot submit a free-form meal prompt or change those constraints.
2. Three parallel AI SDK structured-output calls each propose one metadata-and-ingredient candidate per slot. The model cannot return descriptions or instructions in this pass. If independent lanes collide on a title or very similar core dish, only a conflicting lane is retried with bounded summaries of the accepted peer-lane ideas it must avoid.
3. Pure validation enforces 15 total candidates, exactly three per date, canonical ingredients, US customary source units, no metric prose, convertible and plausible quantities, exact yields and effort, safe temperatures, and unique titles. Lane validation also rejects a core dish that repeats or closely resembles one from the prior 21-day history; changing only a topping, sauce, cheese, garnish, or side is not a distinct dinner.
4. Deterministic exhaustive selection first minimizes pairs of very similar core dishes, then scores protein, cuisine, and technique variety plus useful non-staple ingredient sharing. A reroll follows the same distinctness-first ranking while advancing through the two unused candidates already generated for that date.
5. The review screen shows the locked five-dinner proposal. No recipe rows exist yet.
6. Acceptance claims the saved draft, verifies that the catalog, anonymous dietary notes, preference profile, presence, and serving inputs have not changed, and asks two parallel structured-output calls for descriptions and complete ingredient-keyed instructions only for the selected five.
7. Instruction validation rejects missing required ingredients, foreign ingredient keys, and missing food-safe temperatures. One transaction then creates all five recipes and schedules or replaces their five plan entries.

The recent-meal context uses the half-open window from 21 days before the generated week up to that week. It includes prior planned and cooked plan entries plus recent `lastCookedAt` dates, excludes skipped, replaced, current-week, and future entries, and is capped at 30 summaries.

Weekly runs are household-scoped, expire after two hours, supersede older ready drafts for the same week, and are rate limited per user and household. Audit events store bounded identifiers, model and token usage, and categorized outcomes, never preference text, dietary notes, prompts, or raw model output. Vercel project OIDC supplies Gateway authentication in production.

`/recipes/generate` is a focused generation path for one complete household recipe:

1. The authenticated user supplies a dinner brief, exact servings, effort tier, and active-time ceiling.
2. The server assigns short keys to the 300 canonical ingredients and sends those references to a fixed Vercel AI Gateway model.
3. AI SDK structured output parses the response into a strict Zod schema. Free text model responses are never rendered.
4. Pure domain validation rejects unknown or duplicate ingredient keys, metric source units or prose, invalid conversions, mismatched yield or effort, unsafe timing, prohibited long-dash characters, and missing internal temperatures for higher-risk proteins.
5. A valid draft is returned for review without creating a recipe row.
6. The signed draft is normalized again against a fresh catalog only after the user explicitly saves it. Persistence records `source=generated` and an audit event.

Custom generation requests are also rate limited per user and household. Provider calls use a fixed model, a bounded prompt and output, a timeout, and one semantic retry. Audit events record identifiers, model, timing, token counts, and categorized outcomes but never the user's brief or raw model output.

Neither generation path can yet validate technique-specific salt, fat, or liquid ratios because the canonical ingredient schema does not record culinary roles. Pantry-aware generation, cost scoring, delivery integration, and bench meals remain later work.

## Schema groups

| Group | Tables | Ownership |
| --- | --- | --- |
| Household access | `household`, `app_user`, `household_user` | Membership bridge scopes adults to households |
| Household preferences | `household_preference_profile` | One markdown document per household with last-updater provenance |
| Authentication | `magic_link_token`, `auth_session` | User plus household session identity |
| People | `household_member`, `presence_rule`, `presence_override` | Household-scoped |
| Ingredients | `canonical_ingredient`, `purchase_format` | Shared reference data |
| Recipes | `recipe`, `recipe_ingredient`, `substitution_group`, `substitution_option` | Household recipe with normalized ingredients |
| Week planning | `meal_plan`, `plan_entry`, `weekly_generation_run` | Household-scoped, one plan per week plus expiring validated AI drafts |
| Pantry inventory | `pantry_item` | One household-scoped canonical ingredient count with updater provenance |
| Audit | `event_log` | Household-scoped action history |

Recipe substitution tables are included because manual recipes already reference their schema. The Phase 1 UI does not yet author substitutions.

## UI structure

Routes are explicitly configured in `app/routes.ts`:

- `/auth/sign-in`
- `/auth/verify`
- `/auth/sign-out`
- `/` for the week planner
- `/pantry`
- `/preferences`
- `/presence`
- `/plans/:weekStart/generate`
- `/recipes`
- `/recipes/generate`
- `/recipes/new`
- `/recipes/:recipeId`

React Router loaders perform reads, and actions perform mutations. The application uses server rendering and HTML forms for authentication, presence, and week planning. JavaScript improves pending feedback and powers the dynamic recipe-ingredient builder.

The Done For You Kitchen visual system uses paper neutrals, deep herb green, clay accents, butter yellow, serif display type, compact data labels, and tactile bordered cards. Phone navigation stays reachable at the bottom while account sign-out remains available in the mobile header.

## Future integration seams

The rest of Phase 2 should extend the current pantry snapshot with explicit inventory movements or lots, allocations, shopping lists, retailer products, delivery reconciliation, and PWA offline stores. It should keep canonical units, household scoping, and event logging unchanged.

Phase 3 can consume persisted purchase formats and future pantry state without changing the recipe-entry contract. Phase 4 can extend the existing candidate-only first pass and instruction-only second pass with pantry context, cost-aware scoring, bench selection, swaps, ratings, and rotation.
