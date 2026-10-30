CREATE TABLE "report_case_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"report_id" uuid NOT NULL,
	"case_status" text NOT NULL,
	"authority" text,
	"note" text,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_case_events_case_ck" CHECK (case_status in ('reported', 'confirmed', 'passed_to_authority', 'action_seen', 'closed')),
	CONSTRAINT "report_case_events_note_ck" CHECK (note is null or char_length(note) <= 1000)
);
--> statement-breakpoint
ALTER TABLE "community_reports" ADD COLUMN "category" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "community_reports" ADD COLUMN "district_id" uuid;--> statement-breakpoint
ALTER TABLE "community_reports" ADD COLUMN "satellite_check" jsonb;--> statement-breakpoint
ALTER TABLE "community_reports" ADD COLUMN "satellite_verdict" text DEFAULT 'under_review' NOT NULL;--> statement-breakpoint
ALTER TABLE "community_reports" ADD COLUMN "case_status" text DEFAULT 'reported' NOT NULL;--> statement-breakpoint
ALTER TABLE "community_reports" ADD COLUMN "authority" text;--> statement-breakpoint
ALTER TABLE "report_case_events" ADD CONSTRAINT "report_case_events_report_id_community_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."community_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_case_events" ADD CONSTRAINT "report_case_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_case_events_report_idx" ON "report_case_events" USING btree ("report_id","created_at");--> statement-breakpoint
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_district_id_admin_boundaries_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."admin_boundaries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_category_ck" CHECK (category in ('galamsey', 'dumping', 'fire', 'flooding', 'other'));--> statement-breakpoint
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_verdict_ck" CHECK (satellite_verdict in ('under_review', 'confirmed_by_satellite', 'not_visible_yet'));--> statement-breakpoint
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_case_ck" CHECK (case_status in ('reported', 'confirmed', 'passed_to_authority', 'action_seen', 'closed'));--> statement-breakpoint
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_authority_ck" CHECK (authority is null or authority in ('minerals_commission', 'epa', 'forestry_commission', 'water_resources_commission', 'police', 'district_assembly', 'other'));