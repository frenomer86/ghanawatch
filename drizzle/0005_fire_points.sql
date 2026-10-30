CREATE TABLE "fire_points" (
	"lon" numeric(8, 5) NOT NULL,
	"lat" numeric(7, 5) NOT NULL,
	"acq_date" date NOT NULL,
	"acq_time" text NOT NULL,
	"confidence" text NOT NULL,
	"frp" real,
	"source" text NOT NULL,
	CONSTRAINT "fire_points_lat_lon_acq_date_acq_time_pk" PRIMARY KEY("lat","lon","acq_date","acq_time")
);
--> statement-breakpoint
CREATE INDEX "fire_points_lonlat_idx" ON "fire_points" USING btree ("lon","lat");--> statement-breakpoint
CREATE INDEX "fire_points_date_idx" ON "fire_points" USING btree ("acq_date");