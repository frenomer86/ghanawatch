-- Coastline change along Ghana's shore (src/pipeline/adapters/coastlines.ts).
-- Down: drop table "coast_points".

CREATE TABLE "coast_points" (
	"lon" numeric(8, 5) NOT NULL,
	"lat" numeric(7, 5) NOT NULL,
	"rate_m_yr" real NOT NULL,
	"sig" real,
	"se" real,
	"certainty" text NOT NULL,
	"change_m" real,
	"latest_year" integer,
	"place" text,
	"district_id" uuid,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coast_points_lon_lat_pk" PRIMARY KEY("lon","lat")
);--> statement-breakpoint
ALTER TABLE "coast_points" ADD CONSTRAINT "coast_points_district_id_admin_boundaries_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."admin_boundaries"("id") ON DELETE set null ON UPDATE no action;
