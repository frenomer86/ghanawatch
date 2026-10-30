CREATE TABLE "alert_cells" (
	"cell_id" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone NOT NULL,
	"alerts" integer DEFAULT 0 NOT NULL,
	"tiles" integer DEFAULT 0 NOT NULL
);
