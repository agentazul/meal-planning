CREATE TABLE "cooking_day_off" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"date" date NOT NULL,
	"created_by_app_user_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cooking_day_off_household_date_key" UNIQUE("household_id","date")
);
--> statement-breakpoint
ALTER TABLE "cooking_day_off" ADD CONSTRAINT "cooking_day_off_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cooking_day_off" ADD CONSTRAINT "cooking_day_off_created_by_app_user_id_app_user_id_fk" FOREIGN KEY ("created_by_app_user_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;