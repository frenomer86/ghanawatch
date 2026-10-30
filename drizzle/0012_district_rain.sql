CREATE TABLE "district_rain" (
	"district_id" uuid NOT NULL,
	"day" date NOT NULL,
	"rain_mm" real NOT NULL,
	"rain_hours" real,
	"max_hourly_mm" real,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "district_rain_district_id_day_pk" PRIMARY KEY("district_id","day")
);
--> statement-breakpoint
ALTER TABLE "district_rain" ADD CONSTRAINT "district_rain_district_id_admin_boundaries_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."admin_boundaries"("id") ON DELETE cascade ON UPDATE no action;