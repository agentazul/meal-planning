ALTER TABLE "weekly_generation_run" DROP CONSTRAINT "weekly_generation_run_fingerprint_check";--> statement-breakpoint
ALTER TABLE "weekly_generation_run" ADD COLUMN "dietary_notes_fingerprint" varchar(43);--> statement-breakpoint
UPDATE "weekly_generation_run" SET "dietary_notes_fingerprint" = '55feEBVpymE8u-BRi67SdFQRFFD9hW-ItDXEuTwmRv8' WHERE "dietary_notes_fingerprint" IS NULL;--> statement-breakpoint
ALTER TABLE "weekly_generation_run" ALTER COLUMN "dietary_notes_fingerprint" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "weekly_generation_run" ADD CONSTRAINT "weekly_generation_run_fingerprint_check" CHECK (char_length("weekly_generation_run"."catalog_fingerprint") = 43 AND char_length("weekly_generation_run"."dietary_notes_fingerprint") = 43 AND char_length("weekly_generation_run"."preference_fingerprint") = 43);
