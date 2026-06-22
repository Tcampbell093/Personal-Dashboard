CREATE TYPE "public"."experience_energy_level" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."experience_physical_difficulty" AS ENUM('easy', 'moderate', 'challenging');--> statement-breakpoint
CREATE TYPE "public"."experience_request_status" AS ENUM('draft', 'planned');--> statement-breakpoint
CREATE TYPE "public"."experience_status" AS ENUM('planned', 'completed', 'cancelled', 'not_completed');--> statement-breakpoint
CREATE TABLE "experience_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"request_text" text NOT NULL,
	"available_date" date,
	"available_time_text" varchar(120),
	"budget_max" numeric(12, 2),
	"starting_location" text,
	"max_travel_miles" integer,
	"max_travel_minutes" integer,
	"energy_level" "experience_energy_level",
	"desired_feeling" text,
	"max_physical_difficulty" "experience_physical_difficulty",
	"interests" jsonb DEFAULT '[]'::jsonb,
	"exclusions" jsonb DEFAULT '[]'::jsonb,
	"status" "experience_request_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "experiences" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"request_id" integer NOT NULL,
	"title" varchar(280) NOT NULL,
	"description" text,
	"planned_date" date,
	"planned_time_text" varchar(120),
	"location_text" text,
	"expected_cost" numeric(12, 2),
	"actual_cost" numeric(12, 2),
	"expected_duration_minutes" integer,
	"physical_difficulty" "experience_physical_difficulty",
	"desired_feeling" text,
	"notes" text,
	"status" "experience_status" DEFAULT 'planned' NOT NULL,
	"completed_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"non_completion_reason" text,
	"rating" integer,
	"reflection" text,
	"meaningful_experience" boolean DEFAULT false NOT NULL,
	"adventure_xp" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "experience_requests" ADD CONSTRAINT "experience_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiences" ADD CONSTRAINT "experiences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiences" ADD CONSTRAINT "experiences_request_id_experience_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."experience_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "experience_requests_user_status_idx" ON "experience_requests" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "experiences_user_status_idx" ON "experiences" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "experiences_request_live_uq" ON "experiences" USING btree ("request_id") WHERE "experiences"."deleted_at" is null;