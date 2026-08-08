-- Operator-only rollback for the initial Phase 1 migration.
-- This removes all application data. Back up the database before running it.

BEGIN;

-- This value matches the migration's "when" field in drizzle/meta/_journal.json.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "drizzle"."__drizzle_migrations"
    WHERE "created_at" > 1786225140466
  ) THEN
    RAISE EXCEPTION
      'Refusing to roll back 0000_phase1_foundation while newer migrations are applied';
  END IF;

  IF (
    SELECT count(*)
    FROM "drizzle"."__drizzle_migrations"
    WHERE "created_at" = 1786225140466
  ) <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly one migration ledger row for 0000_phase1_foundation';
  END IF;
END;
$$;

DROP TABLE "substitution_option";
DROP TABLE "recipe_ingredient";
DROP TABLE "substitution_group";
DROP TABLE "plan_entry";
DROP TABLE "meal_plan";
DROP TABLE "recipe";
DROP TABLE "presence_override";
DROP TABLE "presence_rule";
DROP TABLE "auth_session";
DROP TABLE "magic_link_token";
DROP TABLE "household_member";
DROP TABLE "event_log";
DROP TABLE "purchase_format";
DROP TABLE "canonical_ingredient";
DROP TABLE "household_user";
DROP TABLE "app_user";
DROP TABLE "household";

DROP TYPE "storage_class";
DROP TYPE "recipe_source";
DROP TYPE "presence_effect";
DROP TYPE "member_type";
DROP TYPE "ingredient_category";
DROP TYPE "ingredient_base_unit";
DROP TYPE "effort_tier";

DELETE FROM "drizzle"."__drizzle_migrations"
WHERE "created_at" = 1786225140466;

COMMIT;
