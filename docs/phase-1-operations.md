# Phase 1 operations

## Environment variables

| Variable | Runtime | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Required | Pooled PostgreSQL URL used by application requests and seed operations |
| `DATABASE_DIRECT_URL` | Optional | Provider-neutral direct PostgreSQL URL override for migrations |
| `DATABASE_URL_UNPOOLED` | Neon | Neon Marketplace direct URL used by migrations when `DATABASE_DIRECT_URL` is absent |
| `SESSION_COOKIE_SECRET` | Required | Unique value of at least 32 characters used to sign and verify the session cookie |
| `APP_ORIGIN` | Required | Exact public origin; production must use HTTPS |
| `HOUSEHOLD_NAME` | Seed only | Initial household name |
| `HOUSEHOLD_TIMEZONE` | Seed only | Valid IANA timezone for date and presence calculations |
| `HOUSEHOLD_MEMBER_PROFILES_JSON` | Seed only | Preferred strict JSON array of household member profiles |
| `HOUSEHOLD_ADULT_EMAILS` | Seed only | Legacy fallback with exactly two comma-separated adult emails |
| `HOUSEHOLD_SEED_DRY_RUN` | Seed only | `true` executes the full seed transaction and rolls it back |
| `MAGIC_LINK_DELIVERY` | Required | `console` for local development or `smtp` for production |
| `SMTP_HOST` | SMTP | Mail server hostname |
| `SMTP_PORT` | SMTP | Mail server port, default 587 |
| `SMTP_SECURE` | SMTP | `true` for implicit TLS or `false` for STARTTLS |
| `SMTP_USER` | SMTP | Authenticated mail user; required for SMTP delivery |
| `SMTP_PASSWORD` | SMTP | Authenticated mail password; required unless `RESEND_API_KEY` is set |
| `RESEND_API_KEY` | Resend SMTP | Vercel Marketplace credential used as the SMTP password when `SMTP_PASSWORD` is absent |
| `SMTP_FROM` | SMTP | Sender name and email address |

Do not expose seed-only variables to the browser. Do not prefix server variables with `VITE_`.

## Household seed profiles

Use `HOUSEHOLD_MEMBER_PROFILES_JSON` for a real household. It must be a JSON array of strict objects with no extra fields:

```json
[
  {
    "seedKey": "adult-one",
    "displayName": "Adult One",
    "email": "adult-one@example.com",
    "memberType": "adult",
    "appetiteMultiplier": "1.00"
  },
  {
    "seedKey": "adult-two",
    "displayName": "Adult Two",
    "email": "adult-two@example.com",
    "memberType": "adult",
    "appetiteMultiplier": "1.00"
  },
  {
    "seedKey": "teen",
    "displayName": "Teen",
    "email": null,
    "memberType": "child",
    "appetiteMultiplier": "1.40"
  }
]
```

Profile seed keys must be unique lowercase words separated by hyphens. Display names must be unique without regard to case. Appetite multipliers must be decimal strings greater than zero and no greater than 4, with at most two decimal places. Exactly two profiles must contain distinct valid emails, and login profiles must use the `adult` member type.

Treat `seedKey` as permanent identity, not display text. Login members are matched by normalized email and their household user foreign key. Every non-login member receives a deterministic UUID derived from the household ID plus `seedKey`. This lets a later seed find the same row after its display name, member type, appetite, or notes have been edited in the UI. Changing a non-login member's `seedKey` creates a new member; the seed never silently deletes the old row.

On reruns, the seed reconciles each configured member's display name, member type, appetite multiplier, and active status while preserving dietary notes. Configured login names also update `app_user.display_name`. Treat the trusted seed profile as the source of truth for those fields. If profile JSON is blank, `HOUSEHOLD_ADULT_EMAILS` retains the original four-person generic fallback.

Before the first production apply, run the full seed as a rollback-only rehearsal:

```bash
HOUSEHOLD_SEED_DRY_RUN=true npm run db:seed
```

The dry run acquires the seed lock, executes all household, user, member, catalog, format, and event writes, then intentionally rolls the transaction back. It prints counts only and persists no rows, including no `foundation.seed_completed` event.

## Neon setup

1. Create one Neon project and production branch.
2. Copy the pooled connection URL to `DATABASE_URL`.
3. Keep the integration-provided `DATABASE_URL_UNPOOLED` for migrations. A manually managed provider can instead set `DATABASE_DIRECT_URL`.
4. Require TLS through the Neon-provided URLs.
5. Apply committed migrations from a trusted operator environment.
6. Run a seed dry run with the real household name, timezone, and member profiles.
7. Apply the seed, run it a second time, and confirm the configured member count plus exactly 300 ingredients and 300 default formats without duplicates.

The runtime PostgreSQL client uses one connection per request and disables prepared statements, which is compatible with Neon's pooled connection endpoint.

Migration tooling resolves `DATABASE_DIRECT_URL`, then `DATABASE_URL_UNPOOLED`, and only falls back to the pooled `DATABASE_URL` when neither direct key is present. Connections that require TLS use full certificate verification.

The Phase 1 seed serializes seed runs and enforces one household per login user. Reusing either seeded email with a different household name or timezone fails and rolls back instead of creating an ambiguous membership.

## Vercel setup

This repository is linked to the `xsqrd/meal-planning` Vercel project. For a new environment:

1. Import the repository into Vercel.
2. Set Node.js to 22.x, with a version that is at least 22.22.0.
3. Keep the install command as `npm install` or `npm ci` and the build command as `npm run build`.
4. Let Vercel auto-detect React Router and keep the repository's SSR configuration.
5. Add all runtime environment variables for Production. Add a separate database and safe email delivery configuration for Preview if previews can mutate data.
6. Set `APP_ORIGIN` independently for each environment. A production secret must not be copied into uncontrolled preview deployments.
7. Apply migrations before directing traffic to a build that needs them.

After the project is linked, use `vercel env pull .env.local --environment=development` for local development. The file is ignored by Git. Pulling replaces the target file, so keep hand-written local overrides in a separate backup or reapply them afterward. Migration and Drizzle commands load `.env.local` before `.env`. The seed first checks ignored `.env.seed.local`, then `.env.local`, then `.env`, while already-exported process variables retain priority.

The project intentionally does not install `@vercel/react-router`. Its current published package declares React Router 7 peers while this application uses React Router 8.3. Vercel's framework detection can build and serve the app without forcing an incompatible peer dependency. Revisit the preset only after Vercel publishes declared React Router 8 support.

## SMTP setup

Production startup fails when console delivery is configured. Use a transactional mail provider that supports SMTP, then set:

```text
MAGIC_LINK_DELIVERY=smtp
SMTP_HOST=...
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=...
SMTP_PASSWORD=...
SMTP_FROM=Kitchen Ledger <meals@example.com>
```

For the Vercel Resend Marketplace integration, set `SMTP_HOST=smtp.resend.com`, `SMTP_USER=resend`, and either `SMTP_PASSWORD` or the integration-provided `RESEND_API_KEY`. Port 465 with `SMTP_SECURE=true` uses implicit TLS. Port 587 with `SMTP_SECURE=false` uses STARTTLS.

Add the sender domain's SPF, DKIM, and DMARC records before testing real recipients. Never print production magic-link URLs or token query strings.

## Release checklist

1. Review the schema diff and committed SQL migration.
2. Back up the target database.
3. Run `npm ci` on Node 22.22 or newer.
4. Run `npm run check`.
5. Run `npm audit --omit=dev` and resolve production findings.
6. Apply `npm run db:migrate` with the direct database URL.
7. Run `HOUSEHOLD_SEED_DRY_RUN=true npm run db:seed`, verify the summary, then run `npm run db:seed` only when the deployment owns the configured household.
8. Deploy the production build.
9. Request a magic link, confirm it, create a temporary presence override, and verify the corresponding week count.
10. Remove the temporary override and verify the recurring schedule returns.
11. Create and schedule a small test recipe only if production data policy permits it.
12. Inspect server logs for request IDs, five-hundred responses, and database connection errors.

`npm run check` covers prohibited copy characters, generated route types, strict TypeScript, deterministic tests, and the production build. Browser verification remains a separate release gate.

## Migration and rollback

Normal schema evolution must use additive Drizzle migrations. Do not edit a migration after it has been applied outside disposable development databases.

The initial rollback file at `ops/rollback/0000_phase1_foundation.sql` is an operator-only destructive rollback. It removes every Phase 1 table, type, row, and its Drizzle migration ledger row so that a later `npm run db:migrate` can recreate the schema.

Safe rollback procedure:

1. Confirm the exact target database.
2. Take and verify a backup.
3. Stop application writes.
4. Run the rollback SQL with `ON_ERROR_STOP=1`.
5. Confirm the application tables are absent.
6. Restore the backup, or run migrations and seed to create an empty replacement environment.

The rollback is not a data-preserving downgrade. All removed data is unrecoverable without the backup.

## Session and secret response

If a magic-link URL leaks before use, request a fresh link and consume or let the old token expire. If a database dump or session token leaks:

1. Revoke all active rows in `auth_session`.
2. Mark unused rows in `magic_link_token` consumed.
3. Rotate `SESSION_COOKIE_SECRET` in every deployment environment.
4. Rotate database and SMTP credentials if they were in scope.
5. Redeploy and verify both adults can request new links.

Changing `SESSION_COOKIE_SECRET` invalidates existing cookie tokens even when their database rows remain.

## Disposable local database verification

The Phase 1 schema should pass this sequence against a fresh PostgreSQL database:

1. Apply migrations.
2. Run the seed and assert 300 ingredients, 300 purchase formats, one household, two users, the configured member profile count, and two household memberships.
3. Run migrations and seed again and assert the same counts.
4. Apply the rollback in a separate disposable database.
5. Confirm no application table remains.
6. Run migrations again and confirm the schema is recreated.

Destroy the disposable database or container after verification. It contains local test emails and should never become a shared environment.
