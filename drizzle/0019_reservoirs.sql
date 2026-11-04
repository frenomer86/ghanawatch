-- Reservoirs and lakes watched by radar (src/pipeline/adapters/reservoirs.ts).
-- Down: drop tables "reservoir_observations" and "reservoirs".

CREATE TABLE "reservoirs" (
	"slug" text PRIMARY KEY NOT NULL,
	"wb_id" integer NOT NULL,
	"name" text NOT NULL,
	"area_km2" real NOT NULL,
	"geom" jsonb NOT NULL,
	"bbox" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "reservoir_observations" (
	"slug" text NOT NULL,
	"date" date NOT NULL,
	"orbit" text NOT NULL,
	"water_km2" real NOT NULL,
	"water_pct" real NOT NULL,
	"observed_pct" real NOT NULL,
	"threshold_db" real NOT NULL,
	"scenes" integer NOT NULL,
	"method" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservoir_observations_slug_date_orbit_pk" PRIMARY KEY("slug","date","orbit"),
	CONSTRAINT "reservoir_observations_orbit_ck" CHECK (orbit in ('ascending', 'descending'))
);--> statement-breakpoint
ALTER TABLE "reservoir_observations" ADD CONSTRAINT "reservoir_observations_slug_reservoirs_slug_fk" FOREIGN KEY ("slug") REFERENCES "public"."reservoirs"("slug") ON DELETE cascade ON UPDATE no action;
