CREATE TYPE "public"."webhook_event_status" AS ENUM('received', 'processing', 'processed', 'failed', 'ignored');--> statement-breakpoint
CREATE TABLE "plaid_webhook_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" varchar(40) DEFAULT 'plaid' NOT NULL,
	"environment" varchar(20) DEFAULT 'sandbox' NOT NULL,
	"webhook_type" varchar(60) NOT NULL,
	"webhook_code" varchar(80) NOT NULL,
	"provider_item_id" varchar(255) NOT NULL,
	"provider_request_id" varchar(120),
	"body_hash" varchar(64) NOT NULL,
	"status" "webhook_event_status" DEFAULT 'received' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processing_started_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_code" varchar(80),
	"last_error_message" varchar(300),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "plaid_webhook_events_status_idx" ON "plaid_webhook_events" USING btree ("status","webhook_code");--> statement-breakpoint
CREATE INDEX "plaid_webhook_events_item_idx" ON "plaid_webhook_events" USING btree ("provider_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plaid_webhook_events_body_hash_uq" ON "plaid_webhook_events" USING btree ("body_hash");