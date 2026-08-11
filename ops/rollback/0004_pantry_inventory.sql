-- Operator-only rollback for the pantry inventory migration.
-- This permanently removes every recorded pantry count. Back up the database first.

BEGIN;

-- This value matches the migration's "when" field in drizzle/meta/_journal.json.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "drizzle"."__drizzle_migrations"
    WHERE "created_at" > 1786252300291
  ) THEN
    RAISE EXCEPTION
      'Refusing to roll back 0004_pantry_inventory while newer migrations are applied';
  END IF;

  IF (
    SELECT count(*)
    FROM "drizzle"."__drizzle_migrations"
    WHERE "created_at" = 1786252300291
  ) <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly one migration ledger row for 0004_pantry_inventory';
  END IF;
END;
$$;

DROP TABLE "pantry_item";

DELETE FROM "drizzle"."__drizzle_migrations"
WHERE "created_at" = 1786252300291;

COMMIT;
