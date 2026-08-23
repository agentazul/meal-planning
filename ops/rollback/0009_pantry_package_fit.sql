-- Operator-only rollback for recipe edit concurrency and package-fit choices.
-- This does not undo recipe edits or remove their audit events. It refuses to
-- discard saved cross-device choices. Back up the database first.

BEGIN;

-- This value matches the migration's "when" field in drizzle/meta/_journal.json.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "drizzle"."__drizzle_migrations"
    WHERE "created_at" > 1787522358551
  ) THEN
    RAISE EXCEPTION
      'Refusing to roll back 0009_huge_earthquake while newer migrations are applied';
  END IF;

  IF (
    SELECT count(*)
    FROM "drizzle"."__drizzle_migrations"
    WHERE "created_at" = 1787522358551
  ) <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly one migration ledger row for 0009_huge_earthquake';
  END IF;

  IF EXISTS (SELECT 1 FROM "pantry_package_fit_choice") THEN
    RAISE EXCEPTION
      'Refusing to discard saved pantry package-fit choices';
  END IF;
END;
$$;

DROP TABLE "pantry_package_fit_choice";
ALTER TABLE "recipe" DROP CONSTRAINT "recipe_updated_at_check";
ALTER TABLE "recipe" DROP COLUMN "updated_at";

DELETE FROM "drizzle"."__drizzle_migrations"
WHERE "created_at" = 1787522358551;

COMMIT;
