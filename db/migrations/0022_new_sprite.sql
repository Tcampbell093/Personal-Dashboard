CREATE TYPE "public"."daily_recommendation_response" AS ENUM('pending', 'accept', 'defer', 'reject', 'not_relevant', 'complete');--> statement-breakpoint
CREATE TYPE "public"."daily_recommendation_verification" AS ENUM('unverified', 'verified', 'could_not_verify');--> statement-breakpoint
CREATE TABLE "daily_recommendations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"recommendation_key" varchar(240) NOT NULL,
	"domain" varchar(24) NOT NULL,
	"signal_type" varchar(48) NOT NULL,
	"source_refs" jsonb NOT NULL,
	"signal_fingerprint" varchar(64) NOT NULL,
	"presented_on" date NOT NULL,
	"last_presented_at" timestamp with time zone DEFAULT now() NOT NULL,
	"presented_count" integer DEFAULT 1 NOT NULL,
	"snapshot" jsonb NOT NULL,
	"response" "daily_recommendation_response" DEFAULT 'pending' NOT NULL,
	"response_note" text,
	"defer_until" date,
	"responded_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"outcome_note" text,
	"verification_state" "daily_recommendation_verification" DEFAULT 'unverified' NOT NULL,
	"superseded_by_id" integer,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "daily_recommendations" ADD CONSTRAINT "daily_recommendations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_recommendations" ADD CONSTRAINT "daily_recommendations_superseded_by_id_daily_recommendations_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."daily_recommendations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "daily_recommendations_user_idx" ON "daily_recommendations" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_recommendations_active_uq" ON "daily_recommendations" USING btree ("user_id","recommendation_key") WHERE "daily_recommendations"."deleted_at" is null and "daily_recommendations"."superseded_at" is null;