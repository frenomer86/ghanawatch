CREATE TABLE "radar_cells" (
	"cell_id" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone NOT NULL,
	"ponds" integer DEFAULT 0 NOT NULL,
	"recent_scenes" integer DEFAULT 0 NOT NULL,
	"baseline_scenes" integer DEFAULT 0 NOT NULL,
	"coverage" integer,
	"note" text
);
