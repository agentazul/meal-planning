ALTER TABLE "pantry_item" ADD COLUMN "recipe_usage_through_date" date;--> statement-breakpoint
CREATE FUNCTION pg_temp.try_iso_date(candidate text)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
BEGIN
	IF candidate IS NULL OR candidate !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
		RETURN NULL;
	END IF;

	RETURN candidate::date;
EXCEPTION
	WHEN others THEN
		RETURN NULL;
END;
$$;--> statement-breakpoint
UPDATE "pantry_item" AS pantry_item
SET "recipe_usage_through_date" = COALESCE(
	(
		SELECT CASE
			WHEN event_log."event_type" = 'pantry.item_counted' THEN
				(event_log."created_at" AT TIME ZONE COALESCE(
					(
						SELECT timezone_name.name
						FROM pg_timezone_names AS timezone_name
						WHERE timezone_name.name = household."timezone"
						LIMIT 1
					),
					'UTC'
				))::date
			ELSE pg_temp.try_iso_date(event_log."payload" ->> 'weekStart') - 1
		END
		FROM "event_log" AS event_log
		WHERE event_log."household_id" = pantry_item."household_id"
			AND (
				(
					event_log."event_type" = 'pantry.item_counted'
					AND event_log."payload" ->> 'canonicalIngredientId' = pantry_item."canonical_ingredient_id"::text
				)
				OR (
					event_log."event_type" = 'pantry.restock_batch_applied'
					AND pg_temp.try_iso_date(event_log."payload" ->> 'weekStart') IS NOT NULL
					AND EXISTS (
						SELECT 1
						FROM jsonb_array_elements(
							CASE
								WHEN jsonb_typeof(event_log."payload" -> 'items') = 'array'
									THEN event_log."payload" -> 'items'
								ELSE '[]'::jsonb
							END
						) AS restock_item(value)
						WHERE restock_item.value ->> 'canonicalIngredientId' = pantry_item."canonical_ingredient_id"::text
					)
				)
			)
		ORDER BY event_log."created_at" DESC, event_log."id" DESC
		LIMIT 1
	),
	(pantry_item."updated_at" AT TIME ZONE COALESCE(
		(
			SELECT timezone_name.name
			FROM pg_timezone_names AS timezone_name
			WHERE timezone_name.name = household."timezone"
			LIMIT 1
		),
		'UTC'
	))::date
)
FROM "household" AS household
WHERE household."id" = pantry_item."household_id";--> statement-breakpoint
ALTER TABLE "pantry_item" ALTER COLUMN "recipe_usage_through_date" SET NOT NULL;
