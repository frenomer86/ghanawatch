-- The monthly Galamsey Index: an immutable first-seen date on live detections, the historical scan,
-- frozen district and national months, accuracy checks and confirmation samples, water intakes,
-- the corrections log, releases, and alert subscriptions and digests.
-- Down: drop the new tables and the two new columns/indexes on change_events.

ALTER TABLE "change_events" ADD COLUMN "first_image_date" date;--> statement-breakpoint
UPDATE "change_events" SET "first_image_date" = "image_date" WHERE "first_image_date" IS NULL;--> statement-breakpoint
CREATE INDEX "change_events_first_seen_idx" ON "change_events" USING btree ("first_image_date");--> statement-breakpoint

CREATE TABLE "history_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scan_month" text NOT NULL,
	"source_event_id" text NOT NULL,
	"type" text NOT NULL,
	"image_date" date NOT NULL,
	"confidence" text NOT NULL,
	"severity" text NOT NULL,
	"area_ha" numeric(12, 3),
	"district_id" uuid,
	"geom" jsonb,
	"bbox_min_lon" numeric(9, 6),
	"bbox_min_lat" numeric(9, 6),
	"bbox_max_lon" numeric(9, 6),
	"bbox_max_lat" numeric(9, 6),
	"centroid_lon" numeric(9, 6),
	"centroid_lat" numeric(9, 6),
	"method_version" text NOT NULL,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_month" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "history_events_month_ck" CHECK (scan_month ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
ALTER TABLE "history_events" ADD CONSTRAINT "history_events_district_id_admin_boundaries_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."admin_boundaries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "history_events_month_source_uq" ON "history_events" USING btree ("scan_month","source_event_id");--> statement-breakpoint
CREATE INDEX "history_events_district_month_idx" ON "history_events" USING btree ("district_id","scan_month");--> statement-breakpoint
CREATE INDEX "history_events_first_month_idx" ON "history_events" USING btree ("first_month");--> statement-breakpoint

CREATE TABLE "history_progress" (
	"cell_id" text NOT NULL,
	"scan_month" text NOT NULL,
	"status" text NOT NULL,
	"sites" integer DEFAULT 0 NOT NULL,
	"coverage_after" integer,
	"note" text,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "history_progress_cell_id_scan_month_pk" PRIMARY KEY("cell_id","scan_month")
);
--> statement-breakpoint
CREATE INDEX "history_progress_month_idx" ON "history_progress" USING btree ("scan_month");--> statement-breakpoint

CREATE TABLE "district_months" (
	"district_id" uuid NOT NULL,
	"month" text NOT NULL,
	"index_version" text DEFAULT '1.0' NOT NULL,
	"new_ha" real DEFAULT 0 NOT NULL,
	"cum_ha" real DEFAULT 0 NOT NULL,
	"index" real DEFAULT 0 NOT NULL,
	"rank" integer,
	"new_sites" integer DEFAULT 0 NOT NULL,
	"active_sites" integer DEFAULT 0 NOT NULL,
	"pct_forest" real,
	"pct_river" real,
	"pct_unlicensed" real,
	"ci_low" real,
	"ci_high" real,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "district_months_district_id_month_index_version_pk" PRIMARY KEY("district_id","month","index_version")
);
--> statement-breakpoint
ALTER TABLE "district_months" ADD CONSTRAINT "district_months_district_id_admin_boundaries_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."admin_boundaries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "district_months_month_idx" ON "district_months" USING btree ("month","index_version");--> statement-breakpoint

CREATE TABLE "national_months" (
	"month" text NOT NULL,
	"index_version" text DEFAULT '1.0' NOT NULL,
	"new_ha" real DEFAULT 0 NOT NULL,
	"cum_ha" real DEFAULT 0 NOT NULL,
	"ci_low" real,
	"ci_high" real,
	"new_sites" integer DEFAULT 0 NOT NULL,
	"districts_affected" integer DEFAULT 0 NOT NULL,
	"top_district_id" uuid,
	"in_reserves_ha" real DEFAULT 0 NOT NULL,
	"river_km_discoloured" real,
	"partial" boolean DEFAULT false NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "national_months_month_index_version_pk" PRIMARY KEY("month","index_version")
);
--> statement-breakpoint
ALTER TABLE "national_months" ADD CONSTRAINT "national_months_top_district_id_admin_boundaries_id_fk" FOREIGN KEY ("top_district_id") REFERENCES "public"."admin_boundaries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE TABLE "accuracy_checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"checked_on" date NOT NULL,
	"label" text NOT NULL,
	"kind" text NOT NULL,
	"region" text,
	"checked" integer NOT NULL,
	"correct" integer NOT NULL,
	"note" text,
	"headline" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accuracy_checks_counts_ck" CHECK (checked > 0 and correct >= 0 and correct <= checked)
);
--> statement-breakpoint
ALTER TABLE "accuracy_checks" ADD CONSTRAINT "accuracy_checks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accuracy_checks_date_idx" ON "accuracy_checks" USING btree ("checked_on");--> statement-breakpoint

-- The checks published on the accuracy page before this migration, so the page reads from the table from now on.
INSERT INTO "accuracy_checks" ("id", "checked_on", "label", "kind", "checked", "correct", "note", "headline") VALUES
('019a1c10-0000-7000-8000-000000000001', '2026-10-18', 'Check across all of Ghana, after the full rescan', 'optical', 30, 28, 'All of Ghana was scanned again with a rule that also counts a change seen on one clear pass, so cloudy areas are covered better. The two misses were outlines on the edge of cloud.', true),
('019a1c10-0000-7000-8000-000000000002', '2026-10-18', 'Check across all of Ghana, after the full rescan', 'urgent', 10, 10, 'One of the 10 Urgent sites is inside a large licensed mine not yet mapped in OpenStreetMap, so it stays red; it is real mining but not galamsey.', true),
('019a1c10-0000-7000-8000-000000000003', '2026-10-18', 'Cleared ground beside mining pits, newly shown', 'cleared_near_pits', 24, 22, 'The detection-rate check found real mining hidden because it showed as cleared ground without pits. Such clearings beside pits are now shown; 22 of 24 checked were part of active mining (the other two could not be judged through haze).', false),
('019a1c10-0000-7000-8000-000000000004', '2026-10-17', 'Check across all of Ghana, after the national scan finished', 'optical', 30, 25, 'Weighted by how many of each kind the map showed, 85% were correct. Four of the five misses were on the Lake Volta shore in Krachi East and Sene East, where the water level moves; detections there are now shown as possible only. The fifth was new building plots inside Bekwai.', false),
('019a1c10-0000-7000-8000-000000000005', '2026-10-17', 'Check across all of Ghana, after the national scan finished', 'urgent', 10, 10, NULL, false),
('019a1c10-0000-7000-8000-000000000006', '2026-10-17', 'Check across all of Ghana, after the national scan finished', 'radar', 10, 10, NULL, false),
('019a1c10-0000-7000-8000-000000000007', '2026-10-17', 'Second check, after the first fixes (areas scanned by then)', 'optical', 30, 26, 'Radar ponds were sampled more heavily than their share of the map (14 of 187 shown); weighted by what the map shows, the result is 88%. Misses in this sample: a new road corridor, a large earthworks site (building or quarry), farmland by Lake Volta under cloud, and a clearing at a town edge seen through haze.', false),
('019a1c10-0000-7000-8000-000000000008', '2026-10-17', 'Second check, after the first fixes (areas scanned by then)', 'radar', 10, 10, 'Two radar ponds are inside Newmont''s licensed pits and are labelled as such.', false),
('019a1c10-0000-7000-8000-000000000009', '2026-10-17', 'First check, before the fixes', 'optical', 32, 20, 'The 13 false alarms were new building in towns (6), cloud shadows read as pits (4), and seasonally wet ground on the Afram Plains (3).', false),
('019a1c10-0000-7000-8000-00000000000a', '2026-10-17', 'First check, before the fixes', 'radar', 8, 7, NULL, false),
('019a1c10-0000-7000-8000-00000000000b', '2026-10-17', 'Floods: clearing and landfill in waterways, south of 8°N', 'flood_south', 8, 7, 'In the north, river banks and sandbars change with every rainy season and looked like new clearing, so the north is not shown until that can be told apart. Every waterway detection stays marked possible until someone checks it on the ground.', false),
('019a1c10-0000-7000-8000-00000000000c', '2026-10-17', 'Floods: clearing and landfill in waterways, north of 8°N (left out)', 'flood_north', 12, 0, NULL, false),
('019a1c10-0000-7000-8000-00000000000d', '2026-10-18', 'Detection rate: 48 random 1.5 km squares in the 25 main mining districts, judged blind', 'detection_rate', 10, 3, 'Ten of the 48 squares showed new mining. Before the full rescan the map showed a detection in 2 of them; after it, 3 of 10 (7 of 10 counting possible detections). The main causes are cloud and sites smaller than the scan can confirm.', false);
--> statement-breakpoint

CREATE TABLE "confirmation_samples" (
	"id" uuid PRIMARY KEY NOT NULL,
	"month" text NOT NULL,
	"change_event_id" uuid NOT NULL,
	"verdict" text,
	"note" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "confirmation_samples" ADD CONSTRAINT "confirmation_samples_change_event_id_change_events_id_fk" FOREIGN KEY ("change_event_id") REFERENCES "public"."change_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "confirmation_samples" ADD CONSTRAINT "confirmation_samples_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "confirmation_samples_month_event_uq" ON "confirmation_samples" USING btree ("month","change_event_id");--> statement-breakpoint
CREATE INDEX "confirmation_samples_month_idx" ON "confirmation_samples" USING btree ("month");--> statement-breakpoint

CREATE TABLE "water_intakes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"river" text NOT NULL,
	"operator" text DEFAULT 'Ghana Water Ltd' NOT NULL,
	"lon" numeric(9, 6) NOT NULL,
	"lat" numeric(9, 6) NOT NULL,
	"district_id" uuid,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "water_intakes" ADD CONSTRAINT "water_intakes_district_id_admin_boundaries_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."admin_boundaries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "water_intakes_name_uq" ON "water_intakes" USING btree ("name");--> statement-breakpoint

CREATE TABLE "corrections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"published_on" date NOT NULL,
	"month" text,
	"index_version" text NOT NULL,
	"what_changed" text NOT NULL,
	"why" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "corrections_date_idx" ON "corrections" USING btree ("published_on");--> statement-breakpoint

CREATE TABLE "releases" (
	"month" text NOT NULL,
	"index_version" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"doi" text,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"headline" text DEFAULT '' NOT NULL,
	CONSTRAINT "releases_month_index_version_pk" PRIMARY KEY("month","index_version")
);
--> statement-breakpoint

CREATE TABLE "alert_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"district_id" uuid,
	"list" text DEFAULT 'public' NOT NULL,
	"token" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"unsubscribed_at" timestamp with time zone,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_subscriptions_list_ck" CHECK (list in ('public', 'journalists', 'officials'))
);
--> statement-breakpoint
ALTER TABLE "alert_subscriptions" ADD CONSTRAINT "alert_subscriptions_district_id_admin_boundaries_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."admin_boundaries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_subscriptions_email_idx" ON "alert_subscriptions" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "alert_subscriptions_token_uq" ON "alert_subscriptions" USING btree ("token");--> statement-breakpoint

CREATE TABLE "alert_digests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"week_ending" date NOT NULL,
	"new_sites" integer DEFAULT 0 NOT NULL,
	"new_ha" real DEFAULT 0 NOT NULL,
	"districts" integer DEFAULT 0 NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"text" text NOT NULL,
	"emails_sent" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "alert_digests_week_uq" ON "alert_digests" USING btree ("week_ending");
