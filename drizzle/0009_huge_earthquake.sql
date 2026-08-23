CREATE TABLE "pantry_package_fit_choice" (
	"household_id" uuid NOT NULL,
	"meal_plan_id" uuid NOT NULL,
	"canonical_ingredient_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"custom_quantity" numeric(14, 3),
	"custom_unit" text,
	"custom_quantity_in_base_unit" numeric(14, 3),
	"custom_label" text,
	"basis_required_quantity_in_base_unit" numeric(14, 3) NOT NULL,
	"basis_current_quantity_in_base_unit" numeric(14, 3),
	"basis_needed_quantity_in_base_unit" numeric(14, 3) NOT NULL,
	"basis_default_purchase_quantity_in_base_unit" numeric(14, 3),
	"basis_hash" varchar(64) NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by_app_user_id" uuid NOT NULL,
	"updated_by_app_user_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pantry_package_fit_choice_pkey" PRIMARY KEY("household_id","meal_plan_id","canonical_ingredient_id"),
	CONSTRAINT "pantry_package_fit_choice_kind_check" CHECK ("pantry_package_fit_choice"."kind" IN ('keep_recipe_buy_enough', 'custom_store_amount')),
	CONSTRAINT "pantry_package_fit_choice_custom_fields_check" CHECK (("pantry_package_fit_choice"."kind" = 'keep_recipe_buy_enough' AND "pantry_package_fit_choice"."custom_quantity" IS NULL AND "pantry_package_fit_choice"."custom_unit" IS NULL AND "pantry_package_fit_choice"."custom_quantity_in_base_unit" IS NULL AND "pantry_package_fit_choice"."custom_label" IS NULL) OR ("pantry_package_fit_choice"."kind" = 'custom_store_amount' AND "pantry_package_fit_choice"."custom_quantity" IS NOT NULL AND "pantry_package_fit_choice"."custom_unit" IS NOT NULL AND "pantry_package_fit_choice"."custom_quantity_in_base_unit" IS NOT NULL AND "pantry_package_fit_choice"."custom_label" IS NOT NULL)),
	CONSTRAINT "pantry_package_fit_choice_custom_quantity_check" CHECK ("pantry_package_fit_choice"."custom_quantity" IS NULL OR ("pantry_package_fit_choice"."custom_quantity" > 0 AND "pantry_package_fit_choice"."custom_quantity_in_base_unit" > 0)),
	CONSTRAINT "pantry_package_fit_choice_custom_text_check" CHECK (("pantry_package_fit_choice"."custom_unit" IS NULL OR btrim("pantry_package_fit_choice"."custom_unit") <> '') AND ("pantry_package_fit_choice"."custom_label" IS NULL OR btrim("pantry_package_fit_choice"."custom_label") <> '')),
	CONSTRAINT "pantry_package_fit_choice_basis_check" CHECK ("pantry_package_fit_choice"."basis_required_quantity_in_base_unit" >= 0 AND "pantry_package_fit_choice"."basis_needed_quantity_in_base_unit" >= 0 AND ("pantry_package_fit_choice"."basis_current_quantity_in_base_unit" IS NULL OR "pantry_package_fit_choice"."basis_current_quantity_in_base_unit" >= 0) AND ("pantry_package_fit_choice"."basis_default_purchase_quantity_in_base_unit" IS NULL OR "pantry_package_fit_choice"."basis_default_purchase_quantity_in_base_unit" > 0)),
	CONSTRAINT "pantry_package_fit_choice_basis_hash_check" CHECK (char_length("pantry_package_fit_choice"."basis_hash") = 64),
	CONSTRAINT "pantry_package_fit_choice_revision_check" CHECK ("pantry_package_fit_choice"."revision" > 0),
	CONSTRAINT "pantry_package_fit_choice_updated_at_check" CHECK ("pantry_package_fit_choice"."updated_at" >= "pantry_package_fit_choice"."created_at")
);
--> statement-breakpoint
ALTER TABLE "recipe" ADD COLUMN "updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "pantry_package_fit_choice" ADD CONSTRAINT "pantry_package_fit_choice_meal_plan_fkey" FOREIGN KEY ("household_id","meal_plan_id") REFERENCES "public"."meal_plan"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pantry_package_fit_choice" ADD CONSTRAINT "pantry_package_fit_choice_ingredient_fkey" FOREIGN KEY ("canonical_ingredient_id") REFERENCES "public"."canonical_ingredient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pantry_package_fit_choice" ADD CONSTRAINT "pantry_package_fit_choice_creator_fkey" FOREIGN KEY ("household_id","created_by_app_user_id") REFERENCES "public"."household_user"("household_id","app_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pantry_package_fit_choice" ADD CONSTRAINT "pantry_package_fit_choice_updater_fkey" FOREIGN KEY ("household_id","updated_by_app_user_id") REFERENCES "public"."household_user"("household_id","app_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pantry_package_fit_choice_meal_plan_idx" ON "pantry_package_fit_choice" USING btree ("household_id","meal_plan_id","updated_at");--> statement-breakpoint
ALTER TABLE "recipe" ADD CONSTRAINT "recipe_updated_at_check" CHECK ("recipe"."updated_at" >= "recipe"."created_at");