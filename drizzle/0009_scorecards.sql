CREATE TABLE "district_forest_loss" (
	"district_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"loss_ha" real NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "district_forest_loss_district_id_year_pk" PRIMARY KEY("district_id","year")
);
--> statement-breakpoint
ALTER TABLE "fire_points" ADD COLUMN "district_id" uuid;--> statement-breakpoint
ALTER TABLE "district_forest_loss" ADD CONSTRAINT "district_forest_loss_district_id_admin_boundaries_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."admin_boundaries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fire_points_district_date_idx" ON "fire_points" USING btree ("district_id","acq_date");