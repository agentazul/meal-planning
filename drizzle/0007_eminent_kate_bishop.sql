CREATE TABLE "weekly_generation_build" (
	"household_id" uuid NOT NULL,
	"week_start_date" date NOT NULL,
	"owner_token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"requested_by_app_user_id" uuid NOT NULL,
	"phase" text DEFAULT 'candidates' NOT NULL,
	"run_id" uuid,
	"started_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "weekly_generation_build_pkey" PRIMARY KEY("household_id","week_start_date"),
	CONSTRAINT "weekly_generation_build_phase_check" CHECK ("weekly_generation_build"."phase" IN ('candidates')),
	CONSTRAINT "weekly_generation_build_lease_check" CHECK ("weekly_generation_build"."lease_expires_at" > "weekly_generation_build"."started_at")
);
--> statement-breakpoint
ALTER TABLE "weekly_generation_build" ADD CONSTRAINT "weekly_generation_build_household_fkey" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_generation_build" ADD CONSTRAINT "weekly_generation_build_requester_fkey" FOREIGN KEY ("household_id","requested_by_app_user_id") REFERENCES "public"."household_user"("household_id","app_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_generation_build" ADD CONSTRAINT "weekly_generation_build_run_fkey" FOREIGN KEY ("household_id","run_id") REFERENCES "public"."weekly_generation_run"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "weekly_generation_build_lease_idx" ON "weekly_generation_build" USING btree ("household_id","lease_expires_at");--> statement-breakpoint
CREATE INDEX "weekly_generation_build_owner_idx" ON "weekly_generation_build" USING btree ("owner_token");