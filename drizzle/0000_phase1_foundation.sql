CREATE TYPE "public"."effort_tier" AS ENUM('weeknight', 'weekend', 'project');--> statement-breakpoint
CREATE TYPE "public"."ingredient_base_unit" AS ENUM('g', 'ml', 'count');--> statement-breakpoint
CREATE TYPE "public"."ingredient_category" AS ENUM('produce', 'protein', 'dairy', 'pantry', 'spice', 'frozen', 'bakery', 'other');--> statement-breakpoint
CREATE TYPE "public"."member_type" AS ENUM('adult', 'child');--> statement-breakpoint
CREATE TYPE "public"."presence_effect" AS ENUM('present', 'absent');--> statement-breakpoint
CREATE TYPE "public"."recipe_source" AS ENUM('generated', 'imported', 'manual');--> statement-breakpoint
CREATE TYPE "public"."storage_class" AS ENUM('pantry', 'fridge', 'freezer', 'counter');--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_user_email_not_blank_check" CHECK (char_length(btrim("app_user"."email")) > 3),
	CONSTRAINT "app_user_display_name_not_blank_check" CHECK ("app_user"."display_name" IS NULL OR btrim("app_user"."display_name") <> '')
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"app_user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"revoked_at" timestamp (3) with time zone,
	CONSTRAINT "auth_session_token_hash_length_check" CHECK (char_length("auth_session"."token_hash") = 64),
	CONSTRAINT "auth_session_expiry_check" CHECK ("auth_session"."expires_at" > "auth_session"."created_at"),
	CONSTRAINT "auth_session_last_seen_check" CHECK ("auth_session"."last_seen_at" >= "auth_session"."created_at"),
	CONSTRAINT "auth_session_revoked_at_check" CHECK ("auth_session"."revoked_at" IS NULL OR "auth_session"."revoked_at" >= "auth_session"."created_at")
);
--> statement-breakpoint
CREATE TABLE "canonical_ingredient" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"plural_name" text NOT NULL,
	"category" "ingredient_category" NOT NULL,
	"base_unit" "ingredient_base_unit" NOT NULL,
	"density_g_per_ml" numeric(12, 6),
	"grams_per_count" numeric(12, 3),
	"storage_class" "storage_class" NOT NULL,
	"shelf_life_sealed_days" integer NOT NULL,
	"shelf_life_opened_days" integer NOT NULL,
	"survival_probability" numeric(5, 4) NOT NULL,
	"is_staple" boolean DEFAULT false NOT NULL,
	"aliases" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "canonical_ingredient_name_not_blank_check" CHECK (btrim("canonical_ingredient"."name") <> ''),
	CONSTRAINT "canonical_ingredient_plural_name_not_blank_check" CHECK (btrim("canonical_ingredient"."plural_name") <> ''),
	CONSTRAINT "canonical_ingredient_density_check" CHECK ("canonical_ingredient"."density_g_per_ml" IS NULL OR "canonical_ingredient"."density_g_per_ml" > 0),
	CONSTRAINT "canonical_ingredient_grams_per_count_check" CHECK ("canonical_ingredient"."grams_per_count" IS NULL OR "canonical_ingredient"."grams_per_count" > 0),
	CONSTRAINT "canonical_ingredient_shelf_life_check" CHECK ("canonical_ingredient"."shelf_life_sealed_days" >= 0 AND "canonical_ingredient"."shelf_life_opened_days" >= 0),
	CONSTRAINT "canonical_ingredient_survival_probability_check" CHECK ("canonical_ingredient"."survival_probability" >= 0 AND "canonical_ingredient"."survival_probability" <= 1)
);
--> statement-breakpoint
CREATE TABLE "event_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_log_event_type_not_blank_check" CHECK (btrim("event_log"."event_type") <> ''),
	CONSTRAINT "event_log_payload_object_check" CHECK (jsonb_typeof("event_log"."payload") = 'object')
);
--> statement-breakpoint
CREATE TABLE "household_member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"app_user_id" uuid,
	"display_name" text NOT NULL,
	"member_type" "member_type" NOT NULL,
	"appetite_multiplier" numeric(4, 2) DEFAULT '1.00' NOT NULL,
	"dietary_notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_member_household_id_id_key" UNIQUE("household_id","id"),
	CONSTRAINT "household_member_display_name_not_blank_check" CHECK (btrim("household_member"."display_name") <> ''),
	CONSTRAINT "household_member_appetite_multiplier_check" CHECK ("household_member"."appetite_multiplier" > 0 AND "household_member"."appetite_multiplier" <= 4)
);
--> statement-breakpoint
CREATE TABLE "household_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"app_user_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_user_household_id_app_user_id_key" UNIQUE("household_id","app_user_id")
);
--> statement-breakpoint
CREATE TABLE "household" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_name_not_blank_check" CHECK (btrim("household"."name") <> ''),
	CONSTRAINT "household_timezone_not_blank_check" CHECK (btrim("household"."timezone") <> '')
);
--> statement-breakpoint
CREATE TABLE "magic_link_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"consumed_at" timestamp (3) with time zone,
	CONSTRAINT "magic_link_token_token_hash_length_check" CHECK (char_length("magic_link_token"."token_hash") = 64),
	CONSTRAINT "magic_link_token_expiry_check" CHECK ("magic_link_token"."expires_at" > "magic_link_token"."created_at"),
	CONSTRAINT "magic_link_token_consumed_at_check" CHECK ("magic_link_token"."consumed_at" IS NULL OR "magic_link_token"."consumed_at" >= "magic_link_token"."created_at")
);
--> statement-breakpoint
CREATE TABLE "meal_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"week_start_date" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meal_plan_household_id_id_key" UNIQUE("household_id","id"),
	CONSTRAINT "meal_plan_household_week_key" UNIQUE("household_id","week_start_date"),
	CONSTRAINT "meal_plan_status_check" CHECK ("meal_plan"."status" IN ('draft', 'shopping', 'ordered', 'active', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "plan_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"meal_plan_id" uuid NOT NULL,
	"recipe_id" uuid NOT NULL,
	"scheduled_date" date,
	"servings_target" integer NOT NULL,
	"leftover_buffer_servings" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"bench_rank" integer,
	"sequence_hint" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_entry_servings_target_check" CHECK ("plan_entry"."servings_target" >= 0),
	CONSTRAINT "plan_entry_leftover_buffer_check" CHECK ("plan_entry"."leftover_buffer_servings" >= 0),
	CONSTRAINT "plan_entry_status_check" CHECK ("plan_entry"."status" IN ('planned', 'bench', 'cooked', 'skipped', 'swapped_out')),
	CONSTRAINT "plan_entry_schedule_check" CHECK (("plan_entry"."status" = 'bench' AND "plan_entry"."scheduled_date" IS NULL AND "plan_entry"."bench_rank" IS NOT NULL) OR ("plan_entry"."status" <> 'bench' AND "plan_entry"."scheduled_date" IS NOT NULL AND "plan_entry"."bench_rank" IS NULL)),
	CONSTRAINT "plan_entry_bench_rank_check" CHECK ("plan_entry"."bench_rank" IS NULL OR "plan_entry"."bench_rank" > 0),
	CONSTRAINT "plan_entry_sequence_hint_check" CHECK ("plan_entry"."sequence_hint" >= 0)
);
--> statement-breakpoint
CREATE TABLE "presence_override" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"household_member_id" uuid NOT NULL,
	"date" date NOT NULL,
	"is_present" boolean NOT NULL,
	"note" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "presence_override_member_date_key" UNIQUE("household_id","household_member_id","date")
);
--> statement-breakpoint
CREATE TABLE "presence_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"household_member_id" uuid NOT NULL,
	"rrule" text NOT NULL,
	"effect" "presence_effect" NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "presence_rule_rrule_not_blank_check" CHECK (btrim("presence_rule"."rrule") <> ''),
	CONSTRAINT "presence_rule_effective_dates_check" CHECK ("presence_rule"."effective_to" IS NULL OR "presence_rule"."effective_to" >= "presence_rule"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "purchase_format" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_ingredient_id" uuid NOT NULL,
	"description" text NOT NULL,
	"quantity_in_base_unit" numeric(14, 3) NOT NULL,
	"typical_price_cents" integer NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_format_description_not_blank_check" CHECK (btrim("purchase_format"."description") <> ''),
	CONSTRAINT "purchase_format_quantity_check" CHECK ("purchase_format"."quantity_in_base_unit" > 0),
	CONSTRAINT "purchase_format_price_check" CHECK ("purchase_format"."typical_price_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "recipe_ingredient" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"recipe_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"canonical_ingredient_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"unit" text NOT NULL,
	"quantity_in_base_unit" numeric(14, 3) NOT NULL,
	"preparation" text,
	"is_optional" boolean DEFAULT false NOT NULL,
	"scales_linearly" boolean DEFAULT true NOT NULL,
	"substitution_group_id" uuid,
	CONSTRAINT "recipe_ingredient_recipe_position_key" UNIQUE("household_id","recipe_id","position"),
	CONSTRAINT "recipe_ingredient_quantity_check" CHECK ("recipe_ingredient"."quantity" > 0),
	CONSTRAINT "recipe_ingredient_position_check" CHECK ("recipe_ingredient"."position" > 0),
	CONSTRAINT "recipe_ingredient_unit_not_blank_check" CHECK (btrim("recipe_ingredient"."unit") <> ''),
	CONSTRAINT "recipe_ingredient_base_quantity_check" CHECK ("recipe_ingredient"."quantity_in_base_unit" > 0)
);
--> statement-breakpoint
CREATE TABLE "recipe" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"base_servings" integer NOT NULL,
	"active_time_min" integer NOT NULL,
	"total_time_min" integer NOT NULL,
	"effort_tier" "effort_tier" NOT NULL,
	"cuisine" text,
	"primary_protein" text,
	"techniques" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"source" "recipe_source" DEFAULT 'manual' NOT NULL,
	"source_url" text,
	"instructions" jsonb NOT NULL,
	"min_internal_temp_f" integer,
	"in_rotation" boolean DEFAULT false NOT NULL,
	"times_cooked" integer DEFAULT 0 NOT NULL,
	"last_cooked_at" date,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_household_id_id_key" UNIQUE("household_id","id"),
	CONSTRAINT "recipe_title_not_blank_check" CHECK (btrim("recipe"."title") <> ''),
	CONSTRAINT "recipe_base_servings_check" CHECK ("recipe"."base_servings" > 0),
	CONSTRAINT "recipe_time_check" CHECK ("recipe"."active_time_min" >= 0 AND "recipe"."total_time_min" >= "recipe"."active_time_min"),
	CONSTRAINT "recipe_instructions_array_check" CHECK (jsonb_typeof("recipe"."instructions") = 'array'),
	CONSTRAINT "recipe_internal_temperature_check" CHECK ("recipe"."min_internal_temp_f" IS NULL OR ("recipe"."min_internal_temp_f" >= 32 AND "recipe"."min_internal_temp_f" <= 500)),
	CONSTRAINT "recipe_times_cooked_check" CHECK ("recipe"."times_cooked" >= 0)
);
--> statement-breakpoint
CREATE TABLE "substitution_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"recipe_id" uuid NOT NULL,
	"label" text NOT NULL,
	CONSTRAINT "substitution_group_household_recipe_id_key" UNIQUE("household_id","recipe_id","id"),
	CONSTRAINT "substitution_group_label_not_blank_check" CHECK (btrim("substitution_group"."label") <> '')
);
--> statement-breakpoint
CREATE TABLE "substitution_option" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"recipe_id" uuid NOT NULL,
	"substitution_group_id" uuid NOT NULL,
	"canonical_ingredient_id" uuid NOT NULL,
	"conversion_ratio" numeric(12, 6) NOT NULL,
	CONSTRAINT "substitution_option_group_ingredient_key" UNIQUE("household_id","substitution_group_id","canonical_ingredient_id"),
	CONSTRAINT "substitution_option_conversion_ratio_check" CHECK ("substitution_option"."conversion_ratio" > 0)
);
--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_household_user_fkey" FOREIGN KEY ("household_id","app_user_id") REFERENCES "public"."household_user"("household_id","app_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_log" ADD CONSTRAINT "event_log_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_member" ADD CONSTRAINT "household_member_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_member" ADD CONSTRAINT "household_member_household_user_fkey" FOREIGN KEY ("household_id","app_user_id") REFERENCES "public"."household_user"("household_id","app_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_user" ADD CONSTRAINT "household_user_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_user" ADD CONSTRAINT "household_user_app_user_id_app_user_id_fk" FOREIGN KEY ("app_user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "magic_link_token" ADD CONSTRAINT "magic_link_token_app_user_id_app_user_id_fk" FOREIGN KEY ("app_user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_plan" ADD CONSTRAINT "meal_plan_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_entry" ADD CONSTRAINT "plan_entry_meal_plan_fkey" FOREIGN KEY ("household_id","meal_plan_id") REFERENCES "public"."meal_plan"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_entry" ADD CONSTRAINT "plan_entry_recipe_fkey" FOREIGN KEY ("household_id","recipe_id") REFERENCES "public"."recipe"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presence_override" ADD CONSTRAINT "presence_override_household_member_fkey" FOREIGN KEY ("household_id","household_member_id") REFERENCES "public"."household_member"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presence_rule" ADD CONSTRAINT "presence_rule_household_member_fkey" FOREIGN KEY ("household_id","household_member_id") REFERENCES "public"."household_member"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_format" ADD CONSTRAINT "purchase_format_ingredient_fkey" FOREIGN KEY ("canonical_ingredient_id") REFERENCES "public"."canonical_ingredient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredient" ADD CONSTRAINT "recipe_ingredient_canonical_fkey" FOREIGN KEY ("canonical_ingredient_id") REFERENCES "public"."canonical_ingredient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredient" ADD CONSTRAINT "recipe_ingredient_recipe_fkey" FOREIGN KEY ("household_id","recipe_id") REFERENCES "public"."recipe"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredient" ADD CONSTRAINT "recipe_ingredient_substitution_group_fkey" FOREIGN KEY ("household_id","recipe_id","substitution_group_id") REFERENCES "public"."substitution_group"("household_id","recipe_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe" ADD CONSTRAINT "recipe_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "substitution_group" ADD CONSTRAINT "substitution_group_recipe_fkey" FOREIGN KEY ("household_id","recipe_id") REFERENCES "public"."recipe"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "substitution_option" ADD CONSTRAINT "substitution_option_ingredient_fkey" FOREIGN KEY ("canonical_ingredient_id") REFERENCES "public"."canonical_ingredient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "substitution_option" ADD CONSTRAINT "substitution_option_group_fkey" FOREIGN KEY ("household_id","recipe_id","substitution_group_id") REFERENCES "public"."substitution_group"("household_id","recipe_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_email_lower_key" ON "app_user" USING btree (lower(btrim("email")));--> statement-breakpoint
CREATE UNIQUE INDEX "auth_session_token_hash_key" ON "auth_session" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_session_household_id_app_user_id_idx" ON "auth_session" USING btree ("household_id","app_user_id");--> statement-breakpoint
CREATE INDEX "auth_session_expires_at_idx" ON "auth_session" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_ingredient_name_lower_key" ON "canonical_ingredient" USING btree (lower(btrim("name")));--> statement-breakpoint
CREATE INDEX "canonical_ingredient_category_idx" ON "canonical_ingredient" USING btree ("category");--> statement-breakpoint
CREATE INDEX "event_log_household_id_created_at_idx" ON "event_log" USING btree ("household_id","created_at");--> statement-breakpoint
CREATE INDEX "event_log_household_id_event_type_idx" ON "event_log" USING btree ("household_id","event_type");--> statement-breakpoint
CREATE UNIQUE INDEX "household_member_household_id_app_user_id_key" ON "household_member" USING btree ("household_id","app_user_id") WHERE "household_member"."app_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "household_member_household_id_active_idx" ON "household_member" USING btree ("household_id","active");--> statement-breakpoint
CREATE INDEX "household_user_app_user_id_idx" ON "household_user" USING btree ("app_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "magic_link_token_token_hash_key" ON "magic_link_token" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "magic_link_token_app_user_id_created_at_idx" ON "magic_link_token" USING btree ("app_user_id","created_at");--> statement-breakpoint
CREATE INDEX "magic_link_token_expires_at_idx" ON "magic_link_token" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "meal_plan_household_id_status_idx" ON "meal_plan" USING btree ("household_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_entry_scheduled_dinner_key" ON "plan_entry" USING btree ("household_id","meal_plan_id","scheduled_date") WHERE "plan_entry"."scheduled_date" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "plan_entry_meal_plan_status_idx" ON "plan_entry" USING btree ("household_id","meal_plan_id","status");--> statement-breakpoint
CREATE INDEX "plan_entry_recipe_id_idx" ON "plan_entry" USING btree ("household_id","recipe_id");--> statement-breakpoint
CREATE INDEX "presence_rule_member_effective_dates_idx" ON "presence_rule" USING btree ("household_id","household_member_id","effective_from","effective_to");--> statement-breakpoint
CREATE INDEX "presence_rule_member_priority_idx" ON "presence_rule" USING btree ("household_id","household_member_id","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_format_ingredient_description_lower_key" ON "purchase_format" USING btree ("canonical_ingredient_id",lower(btrim("description")));--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_format_one_default_per_ingredient_key" ON "purchase_format" USING btree ("canonical_ingredient_id") WHERE "purchase_format"."is_default" = true;--> statement-breakpoint
CREATE INDEX "purchase_format_canonical_ingredient_id_idx" ON "purchase_format" USING btree ("canonical_ingredient_id");--> statement-breakpoint
CREATE INDEX "recipe_ingredient_canonical_ingredient_id_idx" ON "recipe_ingredient" USING btree ("canonical_ingredient_id");--> statement-breakpoint
CREATE INDEX "recipe_household_id_created_at_idx" ON "recipe" USING btree ("household_id","created_at");--> statement-breakpoint
CREATE INDEX "recipe_household_id_rotation_idx" ON "recipe" USING btree ("household_id","in_rotation");--> statement-breakpoint
CREATE INDEX "recipe_household_id_title_lower_idx" ON "recipe" USING btree ("household_id",lower("title"));--> statement-breakpoint
CREATE UNIQUE INDEX "substitution_group_recipe_label_lower_key" ON "substitution_group" USING btree ("household_id","recipe_id",lower(btrim("label")));--> statement-breakpoint
CREATE INDEX "substitution_option_canonical_ingredient_id_idx" ON "substitution_option" USING btree ("canonical_ingredient_id");