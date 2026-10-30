CREATE TABLE "machinery_sightings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"lon" numeric(9, 6) NOT NULL,
	"lat" numeric(9, 6) NOT NULL,
	"imagery_source" text DEFAULT 'esri-world-imagery' NOT NULL,
	"imagery_release" integer,
	"imagery_captured_on" date,
	"imagery_sensor" text,
	"change_event_id" uuid,
	"note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"submitted_by" uuid,
	"submitted_ip_hash" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machinery_sightings_kind_ck" CHECK (kind in ('excavator', 'truck', 'washing_plant', 'dredger', 'other')),
	CONSTRAINT "machinery_sightings_status_ck" CHECK (status in ('pending', 'confirmed', 'rejected')),
	CONSTRAINT "machinery_sightings_count_ck" CHECK (count between 1 and 50),
	CONSTRAINT "machinery_sightings_note_ck" CHECK (note is null or char_length(note) <= 280),
	CONSTRAINT "machinery_sightings_in_ghana_ck" CHECK (lon between -3.9 and 1.8 and lat between 4.1 and 11.8)
);
--> statement-breakpoint
ALTER TABLE "machinery_sightings" ADD CONSTRAINT "machinery_sightings_change_event_id_change_events_id_fk" FOREIGN KEY ("change_event_id") REFERENCES "public"."change_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machinery_sightings" ADD CONSTRAINT "machinery_sightings_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machinery_sightings" ADD CONSTRAINT "machinery_sightings_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "machinery_sightings_status_created_idx" ON "machinery_sightings" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "machinery_sightings_lonlat_idx" ON "machinery_sightings" USING btree ("lon","lat");