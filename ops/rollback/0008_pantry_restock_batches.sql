-- Operator-only rollback for durable pantry restock batch idempotency.
-- This permanently removes restock replay history. It does not reverse pantry
-- quantities or delete related audit events. Back up the database first.

BEGIN;

-- This value matches the migration's "when" field in drizzle/meta/_journal.json.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "drizzle"."__drizzle_migrations"
    WHERE "created_at" > 1787518296533
  ) THEN
    RAISE EXCEPTION
      'Refusing to roll back 0008_familiar_vulture while newer migrations are applied';
  END IF;

  IF (
    SELECT count(*)
    FROM "drizzle"."__drizzle_migrations"
    WHERE "created_at" = 1787518296533
  ) <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly one migration ledger row for 0008_familiar_vulture';
  END IF;
END;
$$;

DROP TABLE "pantry_restock_batch";

DELETE FROM "drizzle"."__drizzle_migrations"
WHERE "created_at" = 1787518296533;

COMMIT;
