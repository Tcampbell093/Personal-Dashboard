CREATE TYPE "public"."experience_interpretation_source" AS ENUM('manual', 'ai');--> statement-breakpoint
ALTER TYPE "public"."experience_request_status" ADD VALUE 'interpreted' BEFORE 'planned';--> statement-breakpoint
ALTER TABLE "experience_requests" ADD COLUMN "interpretation_source" "experience_interpretation_source" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "experience_requests" ADD COLUMN "interpretation_provider" varchar(60);--> statement-breakpoint
ALTER TABLE "experience_requests" ADD COLUMN "interpretation_model" varchar(120);