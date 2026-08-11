CREATE TABLE "pantry_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"canonical_ingredient_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"unit" text NOT NULL,
	"quantity_in_base_unit" numeric(14, 3) NOT NULL,
	"updated_by_app_user_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pantry_item_household_id_id_key" UNIQUE("household_id","id"),
	CONSTRAINT "pantry_item_household_ingredient_key" UNIQUE("household_id","canonical_ingredient_id"),
	CONSTRAINT "pantry_item_quantity_check" CHECK ("pantry_item"."quantity" >= 0),
	CONSTRAINT "pantry_item_base_quantity_check" CHECK ("pantry_item"."quantity_in_base_unit" >= 0),
	CONSTRAINT "pantry_item_unit_not_blank_check" CHECK (btrim("pantry_item"."unit") <> ''),
	CONSTRAINT "pantry_item_updated_at_check" CHECK ("pantry_item"."updated_at" >= "pantry_item"."created_at")
);
--> statement-breakpoint
ALTER TABLE "pantry_item" ADD CONSTRAINT "pantry_item_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pantry_item" ADD CONSTRAINT "pantry_item_ingredient_fkey" FOREIGN KEY ("canonical_ingredient_id") REFERENCES "public"."canonical_ingredient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pantry_item" ADD CONSTRAINT "pantry_item_updated_by_household_user_fkey" FOREIGN KEY ("household_id","updated_by_app_user_id") REFERENCES "public"."household_user"("household_id","app_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pantry_item_canonical_ingredient_id_idx" ON "pantry_item" USING btree ("canonical_ingredient_id");--> statement-breakpoint
CREATE INDEX "pantry_item_household_updated_at_idx" ON "pantry_item" USING btree ("household_id","updated_at");