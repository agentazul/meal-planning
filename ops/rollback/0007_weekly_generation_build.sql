-- Operator-only rollback for the weekly generation build fencing table.
-- This removes active build leases. Back up the database before running it.

BEGIN;

-- This value matches the migration's "when" field in drizzle/meta/_journal.json.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "drizzle"."__drizzle_migrations"
    WHERE "created_at" > 1786931011285
  ) THEN
    RAISE EXCEPTION
      'Refusing to roll back 0007_weekly_generation_build while newer migrations are applied';
  END IF;

  IF (
    SELECT count(*)
    FROM "drizzle"."__drizzle_migrations"
    WHERE "created_at" = 1786931011285
  ) <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly one migration ledger row for 0007_weekly_generation_build';
  END IF;

  IF EXISTS (SELECT 1 FROM "weekly_generation_build") THEN
    RAISE EXCEPTION
      'Refusing to drop weekly_generation_build while a generation lease is active';
  END IF;
END;
$$;

DROP TABLE "weekly_generation_build";

DELETE FROM "drizzle"."__drizzle_migrations"
WHERE "created_at" = 1786931011285;

COMMIT;
