CREATE TABLE "news_signals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"published_at" timestamp with time zone,
	"event_type" text NOT NULL,
	"place_name" text,
	"place_kind" text,
	"district_id" uuid,
	"lon" numeric(9, 6),
	"lat" numeric(9, 6),
	"confidence" real NOT NULL,
	"triggered" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analysis_cells" ADD COLUMN "recheck_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "news_signals" ADD CONSTRAINT "news_signals_district_id_admin_boundaries_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."admin_boundaries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "news_signals_url_type_uq" ON "news_signals" USING btree ("url","event_type");--> statement-breakpoint
CREATE INDEX "news_signals_published_idx" ON "news_signals" USING btree ("published_at");