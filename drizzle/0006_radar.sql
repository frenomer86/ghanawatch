CREATE TABLE "radar_scenes" (
	"id" text PRIMARY KEY NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"orbit" text,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"river_targets" integer DEFAULT 0 NOT NULL,
	"windows" integer DEFAULT 0 NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "radar_targets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scene_id" text NOT NULL,
	"acq_date" date NOT NULL,
	"lon" numeric(9, 6) NOT NULL,
	"lat" numeric(9, 6) NOT NULL,
	"vv_db" real NOT NULL,
	"vh_db" real,
	"river" text,
	"sighting_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "river_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"osm_ref" text NOT NULL,
	"geom" jsonb NOT NULL,
	"bbox_min_lon" numeric(9, 6) NOT NULL,
	"bbox_min_lat" numeric(9, 6) NOT NULL,
	"bbox_max_lon" numeric(9, 6) NOT NULL,
	"bbox_max_lat" numeric(9, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "river_lines_kind_ck" CHECK (kind in ('river', 'structure'))
);
--> statement-breakpoint
ALTER TABLE "radar_targets" ADD CONSTRAINT "radar_targets_sighting_id_machinery_sightings_id_fk" FOREIGN KEY ("sighting_id") REFERENCES "public"."machinery_sightings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "radar_targets_lonlat_idx" ON "radar_targets" USING btree ("lon","lat");--> statement-breakpoint
CREATE INDEX "radar_targets_date_idx" ON "radar_targets" USING btree ("acq_date");--> statement-breakpoint
CREATE UNIQUE INDEX "radar_targets_scene_pt_uq" ON "radar_targets" USING btree ("scene_id","lon","lat");--> statement-breakpoint
CREATE UNIQUE INDEX "river_lines_osm_uq" ON "river_lines" USING btree ("osm_ref","kind");