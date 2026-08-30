CREATE TABLE "weekly_generation_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"requested_by_app_user_id" uuid NOT NULL,
	"week_start_date" date NOT NULL,
	"phase" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"run_id" uuid,
	"failure_code" varchar(64),
	"failure_message" varchar(240),
	"delivery_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp (3) with time zone,
	"completed_at" timestamp (3) with time zone,
	"lease_expires_at" timestamp (3) with time zone,
	CONSTRAINT "weekly_generation_job_household_id_id_key" UNIQUE("household_id","id"),
	CONSTRAINT "weekly_generation_job_phase_check" CHECK ("weekly_generation_job"."phase" IN ('candidates', 'instructions')),
	CONSTRAINT "weekly_generation_job_status_check" CHECK ("weekly_generation_job"."status" IN ('queued', 'running', 'succeeded', 'failed')),
	CONSTRAINT "weekly_generation_job_phase_run_check" CHECK ("weekly_generation_job"."phase" = 'candidates' OR "weekly_generation_job"."run_id" IS NOT NULL),
	CONSTRAINT "weekly_generation_job_delivery_count_check" CHECK ("weekly_generation_job"."delivery_count" >= 0),
	CONSTRAINT "weekly_generation_job_failure_fields_check" CHECK (("weekly_generation_job"."status" = 'failed' AND "weekly_generation_job"."failure_code" IS NOT NULL AND "weekly_generation_job"."failure_message" IS NOT NULL) OR ("weekly_generation_job"."status" <> 'failed' AND "weekly_generation_job"."failure_code" IS NULL AND "weekly_generation_job"."failure_message" IS NULL)),
	CONSTRAINT "weekly_generation_job_failure_values_check" CHECK (("weekly_generation_job"."failure_code" IS NULL OR "weekly_generation_job"."failure_code" ~ '^[a-z0-9_]{1,64}$') AND ("weekly_generation_job"."failure_message" IS NULL OR ("weekly_generation_job"."failure_message" = btrim("weekly_generation_job"."failure_message") AND "weekly_generation_job"."failure_message" ~ '^[ -~]+$'))),
	CONSTRAINT "weekly_generation_job_state_timestamps_check" CHECK (("weekly_generation_job"."status" = 'queued' AND "weekly_generation_job"."completed_at" IS NULL AND "weekly_generation_job"."lease_expires_at" IS NULL) OR ("weekly_generation_job"."status" = 'running' AND "weekly_generation_job"."started_at" IS NOT NULL AND "weekly_generation_job"."completed_at" IS NULL AND "weekly_generation_job"."lease_expires_at" IS NOT NULL) OR ("weekly_generation_job"."status" IN ('succeeded', 'failed') AND "weekly_generation_job"."completed_at" IS NOT NULL AND "weekly_generation_job"."lease_expires_at" IS NULL)),
	CONSTRAINT "weekly_generation_job_timestamp_order_check" CHECK ("weekly_generation_job"."updated_at" >= "weekly_generation_job"."created_at" AND ("weekly_generation_job"."started_at" IS NULL OR "weekly_generation_job"."started_at" >= "weekly_generation_job"."created_at") AND ("weekly_generation_job"."completed_at" IS NULL OR "weekly_generation_job"."completed_at" >= COALESCE("weekly_generation_job"."started_at", "weekly_generation_job"."created_at")) AND ("weekly_generation_job"."lease_expires_at" IS NULL OR "weekly_generation_job"."lease_expires_at" > "weekly_generation_job"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "weekly_generation_job" ADD CONSTRAINT "weekly_generation_job_household_fkey" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_generation_job" ADD CONSTRAINT "weekly_generation_job_requester_fkey" FOREIGN KEY ("household_id","requested_by_app_user_id") REFERENCES "public"."household_user"("household_id","app_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_generation_job" ADD CONSTRAINT "weekly_generation_job_run_fkey" FOREIGN KEY ("household_id","run_id") REFERENCES "public"."weekly_generation_run"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "weekly_generation_job_household_week_idx" ON "weekly_generation_job" USING btree ("household_id","week_start_date","created_at");--> statement-breakpoint
CREATE INDEX "weekly_generation_job_active_run_idx" ON "weekly_generation_job" USING btree ("household_id","run_id","updated_at") WHERE "weekly_generation_job"."run_id" IS NOT NULL AND "weekly_generation_job"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "weekly_generation_job_recovery_idx" ON "weekly_generation_job" USING btree ("status","lease_expires_at","created_at") WHERE "weekly_generation_job"."status" IN ('queued', 'running');
