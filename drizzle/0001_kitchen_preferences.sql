CREATE TABLE "household_preference_profile" (
	"household_id" uuid PRIMARY KEY NOT NULL,
	"markdown" text NOT NULL,
	"updated_by_app_user_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_preference_profile_markdown_length_check" CHECK (char_length("household_preference_profile"."markdown") BETWEEN 1 AND 12000 AND btrim("household_preference_profile"."markdown") <> ''),
	CONSTRAINT "household_preference_profile_long_dash_check" CHECK (position(chr(8211) in "household_preference_profile"."markdown") = 0 AND position(chr(8212) in "household_preference_profile"."markdown") = 0),
	CONSTRAINT "household_preference_profile_updated_at_check" CHECK ("household_preference_profile"."updated_at" >= "household_preference_profile"."created_at")
);
--> statement-breakpoint
ALTER TABLE "household_preference_profile" ADD CONSTRAINT "household_preference_profile_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_preference_profile" ADD CONSTRAINT "household_preference_profile_updated_by_app_user_id_app_user_id_fk" FOREIGN KEY ("updated_by_app_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "household_preference_profile_updated_by_idx" ON "household_preference_profile" USING btree ("updated_by_app_user_id");