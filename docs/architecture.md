# Phase 1 architecture

## Product boundary

Phase 1 proves the first complete household workflow:

1. A seeded adult requests and confirms a single-use magic link.
2. The adult defines recurring presence or an exact-date exception for any household member.
3. The adult enters a recipe manually or generates and reviews a structured AI draft with normalized ingredients.
4. The adult schedules the recipe on a date.
5. The week view derives the serving target from the people who are home and any deliberate leftovers.

Pantry, allocation, shopping, delivery, reconciliation, carryover value, weekly two-pass generation, and swaps are later phases. The current recipe workshop generates one complete recipe at a time and does not claim to score a week, use pantry inventory, or create bench meals.

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

Recipe input accepts familiar mass, volume, and count units. `app/domain/units.ts` converts the amount to grams, milliliters, or counts before persistence. Conversions that need missing density or per-count metadata fail at the input boundary instead of storing an invented value.

## AI recipe workshop

`/recipes/generate` is a focused generation path for one complete household recipe:

1. The authenticated user supplies a dinner brief, exact servings, effort tier, and active-time ceiling.
2. The server assigns short keys to the 300 canonical ingredients and sends those references to a fixed Vercel AI Gateway model.
3. AI SDK structured output parses the response into a strict Zod schema. Free text model responses are never rendered.
4. Pure domain validation rejects unknown or duplicate ingredient keys, invalid conversions, mismatched yield or effort, unsafe timing, prohibited long-dash characters, and missing internal temperatures for higher-risk proteins.
5. A valid draft is returned for review without creating a recipe row.
6. The signed draft is normalized again against a fresh catalog only after the user explicitly saves it. Persistence records `source=generated` and an audit event.

Generation requests are rate limited per user and household. Provider calls use a fixed model, a bounded prompt and output, a timeout, and one semantic retry. Audit events record identifiers, model, timing, token counts, and categorized outcomes but never the user's brief or raw model output. Vercel project OIDC supplies Gateway authentication in production.

This slice cannot yet validate technique-specific salt, fat, or liquid ratios because the canonical ingredient schema does not record culinary roles. The complete two-pass candidate, scoring, pantry, bench, and preference-profile workflow remains Phase 4 work.

## Phase 1 schema groups

| Group | Tables | Ownership |
| --- | --- | --- |
| Household access | `household`, `app_user`, `household_user` | Membership bridge scopes adults to households |
| Authentication | `magic_link_token`, `auth_session` | User plus household session identity |
| People | `household_member`, `presence_rule`, `presence_override` | Household-scoped |
| Ingredients | `canonical_ingredient`, `purchase_format` | Shared reference data |
| Recipes | `recipe`, `recipe_ingredient`, `substitution_group`, `substitution_option` | Household recipe with normalized ingredients |
| Week planning | `meal_plan`, `plan_entry` | Household-scoped, one plan per week |
| Audit | `event_log` | Household-scoped action history |

Recipe substitution tables are included because manual recipes already reference their schema. The Phase 1 UI does not yet author substitutions.

## UI structure

Routes are explicitly configured in `app/routes.ts`:

- `/auth/sign-in`
- `/auth/verify`
- `/auth/sign-out`
- `/` for the week planner
- `/presence`
- `/recipes`
- `/recipes/generate`
- `/recipes/new`
- `/recipes/:recipeId`

React Router loaders perform reads, and actions perform mutations. The application uses server rendering and HTML forms for authentication, presence, and week planning. JavaScript improves pending feedback and powers the dynamic recipe-ingredient builder.

The Done For You Kitchen visual system uses paper neutrals, deep herb green, clay accents, butter yellow, serif display type, compact data labels, and tactile bordered cards. Phone navigation stays reachable at the bottom while account sign-out remains available in the mobile header.

## Future integration seams

Phase 2 should extend the existing schema with pantry items, allocations, shopping lists, retailer products, delivery reconciliation, and PWA offline stores. It should keep canonical units, household scoping, and event logging unchanged.

Phase 3 can consume persisted purchase formats and future pantry state without changing the recipe-entry contract. Phase 4 can reuse the same strict generated-recipe schema while adding candidate-only output, household preferences, pantry context, deterministic scoring, bench selection, and pass-two instructions.
