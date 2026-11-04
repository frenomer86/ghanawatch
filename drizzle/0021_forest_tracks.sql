-- Boxes of the 10 m Sentinel-2 scan for new tracks into forest reserves (src/pipeline/adapters/forest-tracks.ts).
-- Down: drop table "track_boxes".

CREATE TABLE "track_boxes" (
	"box_id" text PRIMARY KEY NOT NULL,
	"min_lon" double precision NOT NULL,
	"min_lat" double precision NOT NULL,
	"max_lon" double precision NOT NULL,
	"max_lat" double precision NOT NULL,
	"last_run_at" timestamp with time zone,
	"tracks" integer DEFAULT 0 NOT NULL,
	"recent_scenes" integer DEFAULT 0 NOT NULL,
	"clear_share" real
);
