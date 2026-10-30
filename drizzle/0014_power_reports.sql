CREATE TABLE "power_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"lat" numeric(8, 4) NOT NULL,
	"lon" numeric(8, 4) NOT NULL,
	"district_id" uuid,
	"happened_at" timestamp with time zone NOT NULL,
	"ip_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "power_reports_kind_ck" CHECK (kind in ('off', 'on')),
	CONSTRAINT "power_reports_in_ghana_ck" CHECK (lon between -3.4 and 1.3 and lat between 4.6 and 11.3)
);
--> statement-breakpoint
ALTER TABLE "power_reports" ADD CONSTRAINT "power_reports_district_id_admin_boundaries_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."admin_boundaries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "power_reports_time_idx" ON "power_reports" USING btree ("happened_at");--> statement-breakpoint
CREATE INDEX "power_reports_district_idx" ON "power_reports" USING btree ("district_id","happened_at");