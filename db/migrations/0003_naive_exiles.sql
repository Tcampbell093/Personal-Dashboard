ALTER TYPE "public"."experience_request_status" ADD VALUE 'recommendations_ready' BEFORE 'planned';--> statement-breakpoint
ALTER TABLE "experience_requests" ADD COLUMN "recommendations" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "experience_requests" ADD COLUMN "recommendation_source" "experience_interpretation_source";--> statement-breakpoint
ALTER TABLE "experience_requests" ADD COLUMN "recommendation_provider" varchar(60);--> statement-breakpoint
ALTER TABLE "experience_requests" ADD COLUMN "recommendation_model" varchar(120);