CREATE TABLE "admin_boundaries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"level" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"area_km2" numeric(12, 3),
	"population" integer,
	"geom" jsonb,
	"bbox_min_lon" numeric(9, 6),
	"bbox_min_lat" numeric(9, 6),
	"bbox_max_lon" numeric(9, 6),
	"bbox_max_lat" numeric(9, 6),
	"centroid_lon" numeric(9, 6),
	"centroid_lat" numeric(9, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_boundaries_level_ck" CHECK (level in ('region', 'district'))
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"change_event_id" uuid NOT NULL,
	"area_of_interest_id" uuid,
	"severity" text NOT NULL,
	"title_en" text NOT NULL,
	"title_tw" text,
	"body_en" text NOT NULL,
	"body_tw" text,
	"channel" text DEFAULT 'in_app' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"dedupe_key" text NOT NULL,
	"sent_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alerts_severity_ck" CHECK (severity in ('normal', 'watch', 'elevated', 'urgent')),
	CONSTRAINT "alerts_channel_ck" CHECK (channel in ('in_app', 'sms', 'whatsapp', 'push')),
	CONSTRAINT "alerts_status_ck" CHECK (status in ('queued', 'sent', 'failed', 'read'))
);
--> statement-breakpoint
CREATE TABLE "areas_of_interest" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"device_id" text,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"district_id" uuid,
	"radius_m" integer,
	"channels" jsonb DEFAULT '{"inApp":true,"sms":false,"whatsapp":false}'::jsonb NOT NULL,
	"min_severity" text DEFAULT 'watch' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"geom" jsonb,
	"bbox_min_lon" numeric(9, 6),
	"bbox_min_lat" numeric(9, 6),
	"bbox_max_lon" numeric(9, 6),
	"bbox_max_lat" numeric(9, 6),
	"centroid_lon" numeric(9, 6),
	"centroid_lat" numeric(9, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aoi_kind_ck" CHECK (kind in ('district', 'point_radius', 'polygon')),
	CONSTRAINT "aoi_target_ck" CHECK ((district_id is not null) <> (geom is not null)),
	CONSTRAINT "aoi_owner_ck" CHECK (user_id is not null or device_id is not null),
	CONSTRAINT "aoi_min_sev_ck" CHECK (min_severity in ('normal', 'watch', 'elevated', 'urgent'))
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"diff" jsonb,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_id" uuid NOT NULL,
	"source_event_id" text NOT NULL,
	"run_id" uuid,
	"type" text NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"image_date" date NOT NULL,
	"image_date_end" date,
	"confidence" text NOT NULL,
	"confidence_score" numeric(4, 3),
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
	"title_en" text NOT NULL,
	"title_tw" text,
	"description_en" text DEFAULT '' NOT NULL,
	"description_tw" text,
	"status" text DEFAULT 'new' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"method_version" text,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_events_type_ck" CHECK (type in ('vegetation_loss', 'surface_disturbance', 'water_change', 'flood_risk', 'fire')),
	CONSTRAINT "change_events_confidence_ck" CHECK (confidence in ('low', 'medium', 'high')),
	CONSTRAINT "change_events_severity_ck" CHECK (severity in ('normal', 'watch', 'elevated', 'urgent')),
	CONSTRAINT "change_events_status_ck" CHECK (status in ('new', 'reviewed', 'dismissed', 'verified')),
	CONSTRAINT "change_events_area_ck" CHECK (area_ha is null or area_ha >= 0),
	CONSTRAINT "change_events_score_ck" CHECK (confidence_score is null or (confidence_score >= 0 and confidence_score <= 1)),
	CONSTRAINT "change_events_dates_ck" CHECK (image_date <= detected_at::date)
);
--> statement-breakpoint
CREATE TABLE "community_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"change_event_id" uuid,
	"lat" numeric(9, 6) NOT NULL,
	"lon" numeric(9, 6) NOT NULL,
	"accuracy_m" integer,
	"description" text NOT NULL,
	"photo_key" text,
	"photo_sha256" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"moderator_id" uuid,
	"moderation_note" text,
	"moderated_at" timestamp with time zone,
	"submitted_ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_reports_status_ck" CHECK (status in ('pending', 'approved', 'rejected', 'needs_info')),
	CONSTRAINT "community_reports_desc_ck" CHECK (char_length(description) between 1 and 500),
	CONSTRAINT "community_reports_in_ghana_ck" CHECK (lon between -3.4 and 1.3 and lat between 4.6 and 11.3)
);
--> statement-breakpoint
CREATE TABLE "data_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"url" text NOT NULL,
	"doc_url" text,
	"category" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"licence" text NOT NULL,
	"attribution_text" text NOT NULL,
	"cadence" text,
	"resolution_m" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_sources_category_ck" CHECK (category in ('imagery', 'alerts', 'fire', 'flood', 'weather', 'water', 'boundaries', 'protected-areas', 'basemap', 'platform'))
);
--> statement-breakpoint
CREATE TABLE "hotspot_events" (
	"hotspot_id" uuid NOT NULL,
	"change_event_id" uuid NOT NULL,
	CONSTRAINT "hotspot_events_hotspot_id_change_event_id_pk" PRIMARY KEY("hotspot_id","change_event_id")
);
--> statement-breakpoint
CREATE TABLE "hotspots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"type" text NOT NULL,
	"severity" text NOT NULL,
	"event_count" integer NOT NULL,
	"area_ha_total" numeric(14, 3),
	"district_id" uuid,
	"is_new" boolean DEFAULT false NOT NULL,
	"label_en" text NOT NULL,
	"label_tw" text,
	"geom" jsonb,
	"bbox_min_lon" numeric(9, 6),
	"bbox_min_lat" numeric(9, 6),
	"bbox_max_lon" numeric(9, 6),
	"bbox_max_lat" numeric(9, 6),
	"centroid_lon" numeric(9, 6),
	"centroid_lat" numeric(9, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hotspots_type_ck" CHECK (type in ('vegetation_loss', 'surface_disturbance', 'water_change', 'flood_risk', 'fire')),
	CONSTRAINT "hotspots_severity_ck" CHECK (severity in ('normal', 'watch', 'elevated', 'urgent')),
	CONSTRAINT "hotspots_count_ck" CHECK (event_count > 0),
	CONSTRAINT "hotspots_window_ck" CHECK (window_start < window_end)
);
--> statement-breakpoint
CREATE TABLE "image_references" (
	"id" uuid PRIMARY KEY NOT NULL,
	"change_event_id" uuid NOT NULL,
	"role" text NOT NULL,
	"source_id" uuid NOT NULL,
	"product_id" text,
	"sensor" text,
	"acquired_at" timestamp with time zone NOT NULL,
	"cloud_cover_pct" numeric(5, 2),
	"thumbnail_url" text,
	"tile_url_template" text,
	"bbox_min_lon" numeric(9, 6),
	"bbox_min_lat" numeric(9, 6),
	"bbox_max_lon" numeric(9, 6),
	"bbox_max_lat" numeric(9, 6),
	"licence" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "image_references_role_ck" CHECK (role in ('latest', 'before', 'after')),
	CONSTRAINT "image_references_cloud_ck" CHECK (cloud_cover_pct is null or (cloud_cover_pct >= 0 and cloud_cover_pct <= 100))
);
--> statement-breakpoint
CREATE TABLE "pipeline_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"watermark" timestamp with time zone,
	"fetched" integer DEFAULT 0 NOT NULL,
	"inserted" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"error" text,
	CONSTRAINT "pipeline_runs_status_ck" CHECK (status in ('running', 'ok', 'partial', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_hash" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text,
	"phone" text,
	"display_name" text NOT NULL,
	"role" text DEFAULT 'citizen' NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"password_hash" text,
	"email_verified_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_role_ck" CHECK (role in ('citizen', 'moderator', 'admin')),
	CONSTRAINT "users_locale_ck" CHECK (locale in ('en', 'tw'))
);
--> statement-breakpoint
ALTER TABLE "admin_boundaries" ADD CONSTRAINT "admin_boundaries_parent_id_admin_boundaries_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."admin_boundaries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_change_event_id_change_events_id_fk" FOREIGN KEY ("change_event_id") REFERENCES "public"."change_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_area_of_interest_id_areas_of_interest_id_fk" FOREIGN KEY ("area_of_interest_id") REFERENCES "public"."areas_of_interest"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "areas_of_interest" ADD CONSTRAINT "areas_of_interest_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "areas_of_interest" ADD CONSTRAINT "areas_of_interest_district_id_admin_boundaries_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."admin_boundaries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_source_id_data_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."data_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_district_id_admin_boundaries_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."admin_boundaries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_change_event_id_change_events_id_fk" FOREIGN KEY ("change_event_id") REFERENCES "public"."change_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_moderator_id_users_id_fk" FOREIGN KEY ("moderator_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hotspot_events" ADD CONSTRAINT "hotspot_events_hotspot_id_hotspots_id_fk" FOREIGN KEY ("hotspot_id") REFERENCES "public"."hotspots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hotspot_events" ADD CONSTRAINT "hotspot_events_change_event_id_change_events_id_fk" FOREIGN KEY ("change_event_id") REFERENCES "public"."change_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hotspots" ADD CONSTRAINT "hotspots_district_id_admin_boundaries_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."admin_boundaries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_references" ADD CONSTRAINT "image_references_change_event_id_change_events_id_fk" FOREIGN KEY ("change_event_id") REFERENCES "public"."change_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_references" ADD CONSTRAINT "image_references_source_id_data_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."data_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_source_id_data_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."data_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_boundaries_code_uq" ON "admin_boundaries" USING btree ("code");--> statement-breakpoint
CREATE INDEX "admin_boundaries_level_name_idx" ON "admin_boundaries" USING btree ("level","name");--> statement-breakpoint
CREATE INDEX "admin_boundaries_bbox_idx" ON "admin_boundaries" USING btree ("bbox_min_lon","bbox_max_lon","bbox_min_lat","bbox_max_lat");--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_dedupe_uq" ON "alerts" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "alerts_aoi_created_idx" ON "alerts" USING btree ("area_of_interest_id","created_at");--> statement-breakpoint
CREATE INDEX "alerts_public_feed_idx" ON "alerts" USING btree ("created_at") WHERE area_of_interest_id is null;--> statement-breakpoint
CREATE INDEX "alerts_queued_idx" ON "alerts" USING btree ("status") WHERE status = 'queued';--> statement-breakpoint
CREATE INDEX "aoi_user_idx" ON "areas_of_interest" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "aoi_device_idx" ON "areas_of_interest" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "aoi_bbox_idx" ON "areas_of_interest" USING btree ("bbox_min_lon","bbox_max_lon","bbox_min_lat","bbox_max_lat");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "change_events_source_event_uq" ON "change_events" USING btree ("source_id","source_event_id");--> statement-breakpoint
CREATE INDEX "change_events_detected_idx" ON "change_events" USING btree ("detected_at");--> statement-breakpoint
CREATE INDEX "change_events_type_detected_idx" ON "change_events" USING btree ("type","detected_at");--> statement-breakpoint
CREATE INDEX "change_events_district_detected_idx" ON "change_events" USING btree ("district_id","detected_at");--> statement-breakpoint
CREATE INDEX "change_events_severity_detected_idx" ON "change_events" USING btree ("severity","detected_at");--> statement-breakpoint
CREATE INDEX "change_events_bbox_idx" ON "change_events" USING btree ("bbox_min_lon","bbox_max_lon","bbox_min_lat","bbox_max_lat");--> statement-breakpoint
CREATE INDEX "change_events_status_new_idx" ON "change_events" USING btree ("status") WHERE status = 'new';--> statement-breakpoint
CREATE INDEX "community_reports_status_created_idx" ON "community_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "community_reports_latlon_idx" ON "community_reports" USING btree ("lat","lon");--> statement-breakpoint
CREATE UNIQUE INDEX "data_sources_slug_uq" ON "data_sources" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "hotspots_window_end_idx" ON "hotspots" USING btree ("window_end");--> statement-breakpoint
CREATE INDEX "hotspots_bbox_idx" ON "hotspots" USING btree ("bbox_min_lon","bbox_max_lon","bbox_min_lat","bbox_max_lat");--> statement-breakpoint
CREATE INDEX "hotspots_district_idx" ON "hotspots" USING btree ("district_id");--> statement-breakpoint
CREATE INDEX "image_references_event_role_idx" ON "image_references" USING btree ("change_event_id","role");--> statement-breakpoint
CREATE INDEX "pipeline_runs_source_started_idx" ON "pipeline_runs" USING btree ("source_id","started_at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_phone_uq" ON "users" USING btree ("phone");