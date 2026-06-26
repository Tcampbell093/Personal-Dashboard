CREATE TYPE "public"."imported_transaction_status" AS ENUM('active', 'removed');--> statement-breakpoint
CREATE TABLE "imported_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"connection_id" integer NOT NULL,
	"provider_account_id" varchar(255) NOT NULL,
	"financial_account_id" integer,
	"provider" varchar(40) DEFAULT 'plaid' NOT NULL,
	"provider_transaction_id" varchar(255) NOT NULL,
	"pending_provider_transaction_id" varchar(255),
	"status" "imported_transaction_status" DEFAULT 'active' NOT NULL,
	"is_pending" boolean DEFAULT false NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency_code" varchar(8),
	"description_original" varchar(500),
	"description_current" varchar(500) NOT NULL,
	"merchant_name" varchar(200),
	"authorized_date" date,
	"posted_date" date,
	"category_primary" varchar(120),
	"category_detailed" varchar(160),
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "financial_connections" ADD COLUMN "transactions_cursor" text;--> statement-breakpoint
ALTER TABLE "financial_connections" ADD COLUMN "last_transaction_sync_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "financial_connections" ADD COLUMN "last_transaction_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "financial_connections" ADD COLUMN "transaction_sync_locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "financial_connections" ADD COLUMN "transaction_sync_error_code" varchar(80);--> statement-breakpoint
ALTER TABLE "financial_connections" ADD COLUMN "transaction_sync_error_message" varchar(300);--> statement-breakpoint
ALTER TABLE "imported_transactions" ADD CONSTRAINT "imported_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_transactions" ADD CONSTRAINT "imported_transactions_connection_id_financial_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."financial_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_transactions" ADD CONSTRAINT "imported_transactions_financial_account_id_financial_accounts_id_fk" FOREIGN KEY ("financial_account_id") REFERENCES "public"."financial_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "imported_transactions_user_idx" ON "imported_transactions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "imported_transactions_account_idx" ON "imported_transactions" USING btree ("financial_account_id");--> statement-breakpoint
CREATE INDEX "imported_transactions_conn_status_idx" ON "imported_transactions" USING btree ("connection_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "imported_transactions_conn_txn_uq" ON "imported_transactions" USING btree ("connection_id","provider_transaction_id");