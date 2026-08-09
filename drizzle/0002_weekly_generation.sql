CREATE TABLE "weekly_generation_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"requested_by_app_user_id" uuid NOT NULL,
	"meal_plan_id" uuid,
	"week_start_date" date NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"model" text NOT NULL,
	"catalog_fingerprint" varchar(43) NOT NULL,
	"preference_fingerprint" varchar(43) NOT NULL,
	"slots" jsonb NOT NULL,
	"candidates" jsonb NOT NULL,
	"selection" jsonb NOT NULL,
	"reroll_history" jsonb NOT NULL,
	"usage" jsonb NOT NULL,
	"failure_code" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"accepted_at" timestamp (3) with time zone,
	CONSTRAINT "weekly_generation_run_household_id_id_key" UNIQUE("household_id","id"),
	CONSTRAINT "weekly_generation_run_status_check" CHECK ("weekly_generation_run"."status" IN ('ready', 'materializing', 'accepted', 'failed', 'superseded')),
	CONSTRAINT "weekly_generation_run_model_check" CHECK (btrim("weekly_generation_run"."model") <> ''),
	CONSTRAINT "weekly_generation_run_fingerprint_check" CHECK (char_length("weekly_generation_run"."catalog_fingerprint") = 43 AND char_length("weekly_generation_run"."preference_fingerprint") = 43),
	CONSTRAINT "weekly_generation_run_expiry_check" CHECK ("weekly_generation_run"."expires_at" > "weekly_generation_run"."created_at"),
	CONSTRAINT "weekly_generation_run_acceptance_check" CHECK (("weekly_generation_run"."status" = 'accepted' AND "weekly_generation_run"."accepted_at" IS NOT NULL AND "weekly_generation_run"."meal_plan_id" IS NOT NULL) OR ("weekly_generation_run"."status" <> 'accepted' AND "weekly_generation_run"."accepted_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "weekly_generation_run" ADD CONSTRAINT "weekly_generation_run_household_fkey" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_generation_run" ADD CONSTRAINT "weekly_generation_run_requester_fkey" FOREIGN KEY ("household_id","requested_by_app_user_id") REFERENCES "public"."household_user"("household_id","app_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_generation_run" ADD CONSTRAINT "weekly_generation_run_meal_plan_fkey" FOREIGN KEY ("household_id","meal_plan_id") REFERENCES "public"."meal_plan"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "weekly_generation_run_household_week_idx" ON "weekly_generation_run" USING btree ("household_id","week_start_date","created_at");--> statement-breakpoint
CREATE INDEX "weekly_generation_run_household_status_idx" ON "weekly_generation_run" USING btree ("household_id","status","expires_at");