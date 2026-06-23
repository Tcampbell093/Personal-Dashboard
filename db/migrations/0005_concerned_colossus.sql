CREATE TYPE "public"."balance_source" AS ENUM('manual', 'linked');--> statement-breakpoint
ALTER TABLE "financial_accounts" ADD COLUMN "institution" varchar(120);--> statement-breakpoint
ALTER TABLE "financial_accounts" ADD COLUMN "purpose" varchar(40) DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "financial_accounts" ADD COLUMN "balance_source" "balance_source" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "financial_accounts" ADD COLUMN "include_in_spendable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "financial_accounts" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "financial_entries" ADD COLUMN "source_account_id" integer;--> statement-breakpoint
ALTER TABLE "financial_entries" ADD COLUMN "paid_account_id" integer;--> statement-breakpoint
ALTER TABLE "financial_entries" ADD CONSTRAINT "financial_entries_source_account_id_financial_accounts_id_fk" FOREIGN KEY ("source_account_id") REFERENCES "public"."financial_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_entries" ADD CONSTRAINT "financial_entries_paid_account_id_financial_accounts_id_fk" FOREIGN KEY ("paid_account_id") REFERENCES "public"."financial_accounts"("id") ON DELETE no action ON UPDATE no action;