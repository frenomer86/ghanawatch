-- Automatic verification of citizen reports (src/lib/domain/auto-review.ts): where the reported position came
-- from, when the report was made, the original photo's GPS position and time, and the reviewer's decision; and
-- the "unverified" status for reports closed after 30 days with nothing to confirm them.
-- Down: drop the four columns and the location check; restore the status check without 'unverified'.

ALTER TABLE "community_reports" ADD COLUMN "location_source" text;--> statement-breakpoint
ALTER TABLE "community_reports" ADD COLUMN "observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "community_reports" ADD COLUMN "photo_meta" jsonb;--> statement-breakpoint
ALTER TABLE "community_reports" ADD COLUMN "auto_review" jsonb;--> statement-breakpoint
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_location_source_ck" CHECK (location_source is null or location_source in ('photo', 'device', 'pin'));--> statement-breakpoint
ALTER TABLE "community_reports" DROP CONSTRAINT "community_reports_status_ck";--> statement-breakpoint
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_status_ck" CHECK (status in ('pending', 'approved', 'rejected', 'needs_info', 'unverified'));
