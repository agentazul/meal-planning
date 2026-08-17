-- Operator-only rollback for the presence default migration.
-- This permanently removes every household member's saved default presence value. Back up the database before running it.

BEGIN;

-- This value matches the migration's "when" field in drizzle/meta/_journal.json.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "drizzle"."__drizzle_migrations"
    WHERE "created_at" > 1786917841727
  ) THEN
    RAISE EXCEPTION
      'Refusing to roll back 0006_panoramic_iceman while newer migrations are applied';
  END IF;

  IF (
    SELECT count(*)
    FROM "drizzle"."__drizzle_migrations"
    WHERE "created_at" = 1786917841727
  ) <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly one migration ledger row for 0006_panoramic_iceman';
  END IF;
END;
$$;

ALTER TABLE "household_member"
DROP COLUMN "default_is_present";

DELETE FROM "drizzle"."__drizzle_migrations"
WHERE "created_at" = 1786917841727;

COMMIT;
