CREATE TABLE "pantry_restock_batch" (
	"batch_id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"app_user_id" uuid NOT NULL,
	"week_start_date" date NOT NULL,
	"applied_count" integer NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pantry_restock_batch_applied_count_check" CHECK ("pantry_restock_batch"."applied_count" > 0 AND "pantry_restock_batch"."applied_count" <= 100)
);
--> statement-breakpoint
ALTER TABLE "pantry_restock_batch" ADD CONSTRAINT "pantry_restock_batch_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pantry_restock_batch" ADD CONSTRAINT "pantry_restock_batch_household_user_fkey" FOREIGN KEY ("household_id","app_user_id") REFERENCES "public"."household_user"("household_id","app_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pantry_restock_batch_household_week_idx" ON "pantry_restock_batch" USING btree ("household_id","week_start_date","created_at");