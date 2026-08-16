-- Operator-only rollback for household custom pantry items.
-- This removes every custom pantry item. Back up the database before running it.

BEGIN;

-- This value matches the migration's "when" field in drizzle/meta/_journal.json.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "drizzle"."__drizzle_migrations"
    WHERE "created_at" > 1786910996467
  ) THEN
    RAISE EXCEPTION
      'Refusing to roll back 0005_pantry_custom_items while newer migrations are applied';
  END IF;

  IF (
    SELECT count(*)
    FROM "drizzle"."__drizzle_migrations"
    WHERE "created_at" = 1786910996467
  ) <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly one migration ledger row for 0005_pantry_custom_items';
  END IF;
END;
$$;

DROP TABLE "pantry_custom_item";

DELETE FROM "drizzle"."__drizzle_migrations"
WHERE "created_at" = 1786910996467;

COMMIT;
