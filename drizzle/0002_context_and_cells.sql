CREATE TABLE "analysis_cells" (
	"id" text PRIMARY KEY NOT NULL,
	"min_lon" numeric(9, 6) NOT NULL,
	"min_lat" numeric(9, 6) NOT NULL,
	"max_lon" numeric(9, 6) NOT NULL,
	"max_lat" numeric(9, 6) NOT NULL,
	"priority" integer DEFAULT 1 NOT NULL,
	"res_m" integer DEFAULT 40 NOT NULL,
	"region_name" text,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"coverage_after" integer,
	"sites" integer DEFAULT 0 NOT NULL,
	"turbid" integer DEFAULT 0 NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_features" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"osm_ref" text NOT NULL,
	"centroid_lon" numeric(9, 6) NOT NULL,
	"centroid_lat" numeric(9, 6) NOT NULL,
	"bbox_min_lon" numeric(9, 6),
	"bbox_min_lat" numeric(9, 6),
	"bbox_max_lon" numeric(9, 6),
	"bbox_max_lat" numeric(9, 6),
	"geom" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "context_features_kind_ck" CHECK (kind in ('school', 'cemetery', 'health', 'worship', 'settlement', 'residential', 'farm', 'protected_area'))
);
--> statement-breakpoint
CREATE INDEX "analysis_cells_due_idx" ON "analysis_cells" USING btree ("priority","last_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "context_features_osm_uq" ON "context_features" USING btree ("osm_ref","kind");--> statement-breakpoint
CREATE INDEX "context_features_kind_idx" ON "context_features" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "context_features_centroid_idx" ON "context_features" USING btree ("centroid_lon","centroid_lat");