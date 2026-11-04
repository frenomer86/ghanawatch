-- Air quality and heat for every district and day (src/lib/domain/air-heat.ts).
-- Down: drop table "district_air_heat".

CREATE TABLE "district_air_heat" (
	"district_id" uuid NOT NULL,
	"day" date NOT NULL,
	"pm25" real,
	"pm10" real,
	"dust" real,
	"aqi" integer,
	"temp_max_c" real,
	"feels_like_max_c" real,
	"wet_bulb_max_c" real,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "district_air_heat_district_id_day_pk" PRIMARY KEY("district_id","day")
);--> statement-breakpoint
ALTER TABLE "district_air_heat" ADD CONSTRAINT "district_air_heat_district_id_admin_boundaries_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."admin_boundaries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "district_air_heat_day_idx" ON "district_air_heat" USING btree ("day");
