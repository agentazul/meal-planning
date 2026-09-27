# Current architecture

## Product boundary

The application supports this household workflow:

1. A seeded adult requests and confirms a single-use magic link.
2. The adult chooses each member's usual presence, then adds a repeating schedule or taps an exact-date exception only when needed.
3. The adult maintains one shared kitchen preference document for allergies, dislikes, flavors, equipment, and weeknight limits.
4. The adult asks the weekly planner for a prompt-free dinner draft, sized to the week's eligible cooking days (up to 5), based on presence, days off, serving targets, preferences, estimated pantry quantities at the start of the generated week, the prior 21 days of planned or cooked meals, and the canonical catalog.
5. The adult reviews every saved choice for each night, can generate three additional ideas for one night, and then accepts the set to create complete recipes and schedule all of that week's dates atomically.
6. Manual entry and a one-off custom AI recipe workshop remain available for individual recipes.
7. The week view derives each serving target from the people who are home and any deliberate leftovers.
8. The pantry view turns a selected week's planned recipe ingredients into a focused first inventory, lets either adult correct the actual amount after off-plan use, and derives the remaining purchase gaps immediately after each saved count.
9. Before export, material package mismatches require an explicit choice: permanently adjust a saved recipe, keep it and buy enough whole packages, or persist a different store amount.
10. After shopping, the adult explicitly reviews the derived rows, skips anything not bought, accepts the resolved package or store amount, or enters a new audible quantity, and applies the selected groceries to the pantry atomically.

Pantry counts, estimated recipe-use roll-forward, a derived weekly shopping view, persisted package-fit decisions, and an explicit reviewed grocery-restock action are active. Full shopping-list checkoff state, allocation, delivery, retailer reconciliation, inventory lots, confirmed cooking events, carryover value, bench meals, and swaps are later phases. The current weekly generator sends bounded canonical quantities estimated to remain at the generated week's start and scores validated candidates for pantry coverage, variety, and useful non-staple ingredient overlap. Safety, dietary restrictions, serving requirements, and variety remain hard priorities. It does not claim exact physical counts, cost optimization, zero-store behavior, or bench selection.

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

Presence is generic rather than tied to one family schedule. Meal-planning
eligibility and presence are separate: an active member may be Usually home or
Usually away, while a paused member is excluded from every serving calculation.

Resolution for one active member and one date is:

1. Use the exact-date override when one exists.
2. Otherwise evaluate matching recurrence rules by descending numeric priority.
3. Use the first matching rule's present or absent effect.
4. Otherwise use that member's saved Usually home or Usually away baseline.

Rules store an iCalendar RRULE string plus an effective date range. The product
UI creates common weekly and every-two-weeks patterns in plain language. The
resolver retains generic RRULE support for existing data, but technical rule
syntax and priority are not primary household controls. Exact-date changes are
available directly in the seven-day calendar and always take precedence.
Date-only Temporal values keep behavior stable across server timezones and
daylight-saving changes.

The member status control is intentionally separate and explicit. Pausing a
member means they should not be counted on any meal plan. It is not the tool for
travel, custody, or occasional visits; Usually away plus date changes handles
those cases. Seed reruns preserve this user-managed status and the usual
presence baseline.

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

## Cooking days

Households can turn specific dates off from cooking. Per-date day-off state is stored in the `cooking_day_off` table as household-scoped rows, one per date, and toggled from the week view. A day off cannot be set on a date that already has a planned dinner, and scheduling a dinner onto a day off is rejected. An eligible day for the weekly draft is one that is not a day off and has a positive serving target; the draft plans a dinner for min(5, eligible days) of those dates, down to a minimum of 1 eligible day. If every day in the week is off or has a zero serving target, the draft cannot be created. Accepting a previously built draft is rejected if any of its planned dates was turned off after the draft was generated, since the accepted schedule would then conflict with the household's current day-off state.

## Ingredients and units

Canonical ingredients are global reference data. Household data never changes their identity.

Each ingredient records:

- category, base unit, storage class, and shelf life
- sealed and opened survival assumptions
- density or grams per count when a conversion needs it
- staple status and aliases
- one seeded default purchase format with quantity and typical price

Default purchase formats persist both their display description and a structured quantity in the ingredient's canonical base unit. Ingredients that support whole-item entry also carry an average grams-per-count conversion. Those averages make audibles such as `2 count` lemons convertible; the server rejects a count conversion when the catalog has no such metadata rather than inventing one.

The checked-in manifest contains exactly 300 unique ingredients across produce, protein, dairy, pantry, spice, frozen, bakery, and other categories. The seed is deterministic and idempotent.

## Pantry inventory

`/pantry` maintains one recorded balance per household and canonical ingredient. Each row preserves the amount and US kitchen unit entered by the adult, the equivalent canonical quantity in grams, milliliters, or count, the updating user, timestamps, and a recipe-use checkpoint date. A zero row means the ingredient was counted and is empty. No row means it has not been counted, so the UI never mistakes unknown inventory for zero inventory.

For a selected or generated week, the pantry forecast subtracts required nonoptional quantities from scheduled `planned` or `cooked` dinners strictly after each ingredient's checkpoint and before the forecast date. Linear recipe lines scale by the scheduled serving target; nonlinear lines use one recipe quantity. The result is rounded in canonical units and floored at zero. Because the current UI does not yet record cooked or skipped confirmations, a past scheduled dinner is explicitly treated as presumed cooked. This is a likely balance, not an assertion about exact physical use.

A manual count is authoritative and moves that ingredient's checkpoint to the household's current date. Earlier planned use is therefore never replayed after a correction. A grocery restock first rolls a known balance forward through the day before the restocked week, then adds the purchase or replaces the balance with the reviewed total. Its checkpoint moves forward in the same transaction. Unknown inventory remains unknown rather than being created as an inferred zero.

The selected week's checklist reads only planned meal entries, scales linear recipe ingredients from base servings to the stored serving target, keeps non-linear quantities at one recipe amount, and aggregates repeated ingredients. Optional-only ingredients stay visibly optional. Every weekly row exposes its absolute-count controls directly instead of hiding them in a disclosure. The comparison is a read model: it reports uncounted, below-plan, or covered inventory without reserving or subtracting anything.

The same read model populates a live shopping panel after every saved count. Required ingredients with a confirmed shortage show the exact gap to buy. For each structured default purchase format, the recommendation is `ceil(shortage / default package quantity)` whole packages, so the package plan covers the required gap instead of assuming one package is sufficient. Uncounted ingredients stay in Check first because unknown inventory is not zero. Covered ingredients leave the purchase list, and optional-only gaps remain separate from required purchases. The ingredient rows remain derived and do not claim checkoffs, ordering, allocation, or reconciliation state.

A package-fit analysis flags material mismatches rather than silently accepting a poor package-to-recipe fit. It preserves each contributing plan entry and recipe line, excludes optional demand when required demand exists, and shows package coverage, surplus, per-serving impact, and culinary risk. The final Apple Notes export and Groceries are home action are gated until every weekly unknown, including optional ingredients, has been counted and every flagged ingredient has a decision. This prevents an uncounted lemon from silently becoming the catalog's default bag. Protein, nonlinear, fractional-count, repeated-line, and method-sensitive edits require manual judgment and are never silently applied.

`pantry_package_fit_choice` stores only the household's decision for one meal plan and canonical ingredient. A keep-recipe choice authorizes the whole-package fallback. A custom-store choice stores the exact display label plus its quantity, unit, and server-converted canonical amount; for example, `2 large lemons` and `2 count` remain distinct from a `2 lb bag`. Each row also stores a hash of recipe demand, current pantry quantity, shortage, default package quantity, and conversion metadata. A changed basis invalidates the choice instead of reusing a stale decision across devices. The choice and its audit event are written atomically.

A permanent recipe choice updates the saved recipe ingredient quantity and the complete method together. It is not a week override: current, future, and previously planned entries that reference the recipe all see the updated recipe. The action requires an acknowledgement, locks and checks `recipe.updated_at`, converts the new amount server-side, and writes before/after data to `recipe.package_fit_edited`.

Groceries are home is an explicit mutation layered on that derived view. It preselects the current shopping rows with the calculated whole-package count, then requires the adult to review the batch. The exact package count displayed is what the default restock adds. Rows can be skipped, and an audible can replace that default with the amount and compatible unit actually purchased. Audibles add the actual entered amount rather than the suggested package quantity, so an audible that does not cover the plan remains visible as still needed. Known pantry balances first materialize presumed recipe use through the prior week, then add the purchase. For previously unknown inventory, the safe default explicitly sets the reviewed purchase as the total now on hand; an adult can instead choose to add when food was already present.

One household-scoped transaction creates a `pantry_restock_batch`, validates every selected catalog ingredient and conversion, updates every pantry balance, and writes one bounded `pantry.restock_batch_applied` event. The client-generated batch UUID is the durable idempotency key: replaying that UUID returns the prior applied count without changing pantry balances or writing another audit event. The batch row records actor, household, week, item count, and time only. It is not a receipt, purchase line, inventory lot, persisted shopping checkoff, or retailer-reconciliation record.

Every inventory save is an absolute count and an atomic household-scoped upsert. This makes a repeated form submission converge on the same number and gives adults a direct way to record sandwich ingredients, spills, restocking, or any other off-plan change. The mutation also writes a bounded `pantry.item_counted` audit event. Scheduling or removing a recipe never changes pantry quantity.

This inventory slice uses structured default package quantities as editable restock inputs and forecasts recipe use from scheduled dinners. It deliberately does not model package instances, lots, opened dates, expiry, receipts, confirmed cooking, persisted checkoffs, or retailer reconciliation. A future cooked/skipped workflow can replace the current presumed-use rule with authoritative consumption events.

Adults can also add an ad hoc pantry item when it is not in the canonical ingredient catalog. A custom item is household-scoped, stores the entered display name plus a normalized name key, base unit, storage class, quantity, and updater provenance, and is subject to the same nonnegative quantity and absolute-count rules as canonical inventory. Custom items are private to the household and are never sent to the weekly planner or treated as canonical recipe ingredients. The selected-week checklist does not match recipe coverage against custom item names, because a name match cannot establish ingredient identity or a safe unit conversion.

Household recipe entry, AI output, review screens, and saved recipe pages use US customary cooking units. `app/domain/units.ts` converts those amounts to grams, milliliters, or counts for internal persistence and arithmetic. Legacy metric recipe rows are converted at presentation time instead of being destructively rewritten. Conversions that need missing density or per-count metadata fail at the input boundary instead of storing an invented value.

## AI weekly planner and custom workshop

`/plans/:weekStart/generate` is the primary prompt-free generation path:

1. The server derives N dinner slots from presence demand, days off, exact serving targets, and weekday or weekend effort limits, where N is the number of eligible days (not a day off, and with a positive serving target) up to a maximum of 5. The browser cannot submit a free-form meal prompt or change those constraints.
2. Three ordered AI SDK structured-output calls each propose one metadata-and-ingredient candidate per slot. Each later lane receives bounded summaries of the valid candidates already proposed, reducing cross-lane collisions before repair while keeping prompts and raw output out of logs. The model cannot return descriptions or instructions in this pass. When one candidate fails history, unit, safety, or cross-lane similarity validation, the planner preserves the other 3N-1 and requests three replacement alternatives only for the offending date. Gemini uses medium reasoning for these constrained repairs, and the planner accepts the first alternative that passes every existing check. If one side of a cross-lane collision exhausts its repairs, the other conflicting candidate is tried next. A whole lane is retried only when malformed output cannot be tied safely to one candidate, and each lane remains bounded to five provider calls.
3. Pure validation enforces 3N total candidates (3 per slot), canonical ingredients, US customary source units, no metric prose, convertible and plausible quantities, exact yields and effort, safe temperatures, and unique titles. Lane validation also rejects a core dish that repeats or closely resembles one from the prior 21-day history; changing only a topping, sauce, cheese, garnish, or side is not a distinct dinner.
4. Deterministic exhaustive selection first minimizes pairs of very similar core dishes, then scores protein, cuisine, technique variety, useful non-staple ingredient sharing, and bounded coverage from estimated week-start pantry balances. Pantry is a soft preference and cannot override safety, dietary, serving, history, or variety constraints.
5. The same route replaces its start state with the N-dinner review, all saved choices for each night, and a combined ingredient summary derived from the currently selected candidates. Choosing any earlier option updates that summary. A durable per-night job can generate and append three fresh candidates while retaining every previous choice, up to 12 choices for that date. No recipe rows exist yet.
6. Acceptance claims the saved draft, verifies that the catalog, anonymous dietary notes, preference profile, pantry forecast, scheduled commitments, presence, serving inputs, and cooking-day-off status have not changed, and asks two parallel structured-output calls for descriptions and complete ingredient-keyed instructions only for the selected N. Forecast reads do not mutate inventory; the next manual count or grocery restock advances the recipe-use checkpoint.
7. Instruction validation rejects missing required ingredients, foreign ingredient keys, and missing food-safe temperatures. One transaction then creates all N recipes and schedules or replaces their N plan entries.

The recent-meal context uses the half-open window from 21 days before the generated week up to that week. It includes prior planned and cooked plan entries plus recent `lastCookedAt` dates, excludes skipped, replaced, current-week, and future entries, and is capped at 30 summaries.

Weekly runs are household-scoped and expire after two hours. Publishing a new
draft does not invalidate an earlier ready review URL. Weekly draft creation has no application-level
per-user, per-household, completed-draft, or raw-request allowance. Only one
build may run for a household and week at a time; another tab or household
member receives a clear conflict response while the active build continues.
Prior ready review URLs remain valid until their normal expiration or
acceptance. Selecting a saved per-night candidate does not call the provider.
Requesting three fresh ideas starts a durable, idempotent provider job for that
one date while keeping the rest of the draft unchanged. Audit events store bounded identifiers, model and
token usage, and categorized outcomes, never preference text, dietary notes,
prompts, pantry quantities, or raw model output. Server-only
`GOOGLE_VERTEX_API_KEY` credentials authenticate direct Vertex AI Express calls.

`/recipes/generate` is a focused generation path for one complete household recipe:

1. The authenticated user supplies a dinner brief, exact servings, effort tier, and active-time ceiling.
2. The server assigns short keys to the 300 canonical ingredients and sends those references to a fixed Gemini model through Google Vertex AI Express.
3. AI SDK structured output parses the response into a strict Zod schema. Free text model responses are never rendered.
4. Pure domain validation rejects unknown or duplicate ingredient keys, metric source units or prose, invalid conversions, mismatched yield or effort, unsafe timing, prohibited long-dash characters, and missing internal temperatures for higher-risk proteins.
5. A valid draft is returned for review without creating a recipe row.
6. The signed draft is normalized again against a fresh catalog only after the user explicitly saves it. Persistence records `source=generated` and an audit event.

Custom generation requests have no application-level allowance. Provider calls use a fixed model, a bounded prompt and output, a timeout, and one semantic retry. Audit events record identifiers, model, timing, token counts, and categorized outcomes but never the user's brief or raw model output.

Neither generation path can yet validate technique-specific salt, fat, or liquid ratios because the canonical ingredient schema does not record culinary roles. Cost scoring, delivery integration, and bench meals remain later work.

## Schema groups

| Group                 | Tables                                                                                   | Ownership                                                                |
| --------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Household access      | `household`, `app_user`, `household_user`                                                | Membership bridge scopes adults to households                            |
| Household preferences | `household_preference_profile`                                                           | One markdown document per household with last-updater provenance         |
| Authentication        | `magic_link_token`, `auth_session`                                                       | User plus household session identity                                     |
| People                | `household_member`, `presence_rule`, `presence_override`                                 | Household-scoped                                                         |
| Ingredients           | `canonical_ingredient`, `purchase_format`                                                | Shared reference data                                                    |
| Recipes               | `recipe`, `recipe_ingredient`, `substitution_group`, `substitution_option`               | Household recipe with normalized ingredients and optimistic edit version |
| Week planning         | `meal_plan`, `plan_entry`, `weekly_generation_run`                                       | Household-scoped, one plan per week plus expiring validated AI drafts    |
| Pantry inventory      | `pantry_item`, `pantry_custom_item`, `pantry_package_fit_choice`, `pantry_restock_batch` | Household counts, package decisions, and durable restock idempotency     |
| Audit                 | `event_log`                                                                              | Household-scoped action history                                          |

Recipe substitution tables are included because manual recipes already reference their schema. The Phase 1 UI does not yet author substitutions.

## UI structure

Routes are explicitly configured in `app/routes.ts`:

- `/auth/sign-in`
- `/auth/verify`
- `/auth/sign-out`
- `/` for the week planner
- `/pantry`
- `/pantry/package-fit`
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

The rest of Phase 2 should extend the current pantry snapshot with explicit inventory movements or lots, allocations, persisted shopping checkoffs, retailer products, delivery reconciliation, and PWA offline stores. A future receipt or reconciliation model may reference a restock batch, but must not reinterpret its idempotency row as purchase-line history. It should keep canonical units, household scoping, and event logging unchanged.

Phase 3 can consume persisted purchase formats and future pantry state without changing the recipe-entry contract. Phase 4 can extend the existing candidate-only first pass and instruction-only second pass with pantry context, cost-aware scoring, bench selection, swaps, ratings, and rotation.
