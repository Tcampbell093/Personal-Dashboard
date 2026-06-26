CREATE TYPE "public"."connection_status" AS ENUM('active', 'login_required', 'pending_expiration', 'error', 'revoked');--> statement-breakpoint
CREATE TABLE "financial_connections" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"provider" varchar(40) DEFAULT 'plaid' NOT NULL,
	"provider_item_id" varchar(255) NOT NULL,
	"institution_id" varchar(120),
	"institution_name" varchar(200),
	"access_token_cipher" text NOT NULL,
	"access_token_nonce" text NOT NULL,
	"access_token_tag" text NOT NULL,
	"access_token_key_version" integer NOT NULL,
	"access_token_envelope_version" integer NOT NULL,
	"status" "connection_status" DEFAULT 'active' NOT NULL,
	"environment" varchar(20) DEFAULT 'sandbox' NOT NULL,
	"consent_granted_at" timestamp with time zone,
	"last_sync_attempted_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"requires_reauth" boolean DEFAULT false NOT NULL,
	"error_code" varchar(80),
	"error_message" varchar(300),
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "financial_connections" ADD CONSTRAINT "financial_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "financial_connections_user_idx" ON "financial_connections" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_connections_owner_item_uq" ON "financial_connections" USING btree ("user_id","provider","provider_item_id");