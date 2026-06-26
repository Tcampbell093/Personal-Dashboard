CREATE TYPE "public"."provider_account_status" AS ENUM('active', 'stale');--> statement-breakpoint
CREATE TABLE "provider_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"connection_id" integer NOT NULL,
	"provider" varchar(40) DEFAULT 'plaid' NOT NULL,
	"provider_account_id" varchar(255) NOT NULL,
	"financial_account_id" integer,
	"provider_name" varchar(200) NOT NULL,
	"official_name" varchar(200),
	"mask" varchar(16),
	"provider_type" varchar(40) DEFAULT 'other' NOT NULL,
	"provider_subtype" varchar(60),
	"currency_code" varchar(8),
	"balance_current" numeric(14, 2),
	"balance_available" numeric(14, 2),
	"balance_limit" numeric(14, 2),
	"balance_as_of" timestamp with time zone,
	"status" "provider_account_status" DEFAULT 'active' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_connection_id_financial_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."financial_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_financial_account_id_financial_accounts_id_fk" FOREIGN KEY ("financial_account_id") REFERENCES "public"."financial_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_accounts_user_idx" ON "provider_accounts" USING btree ("user_id","connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_accounts_conn_acct_uq" ON "provider_accounts" USING btree ("connection_id","provider_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_accounts_financial_acct_uq" ON "provider_accounts" USING btree ("financial_account_id") WHERE "provider_accounts"."financial_account_id" IS NOT NULL;