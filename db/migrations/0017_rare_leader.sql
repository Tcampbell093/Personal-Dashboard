CREATE TYPE "public"."event_confirmation_mode" AS ENUM('manual_workflow', 'linked_evidence');--> statement-breakpoint
CREATE TYPE "public"."event_evidence_type" AS ENUM('income_receipt', 'transfer');--> statement-breakpoint
ALTER TYPE "public"."income_status" ADD VALUE 'received_evidence';--> statement-breakpoint
CREATE TABLE "financial_event_evidence" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"event_type" "event_evidence_type" NOT NULL,
	"confirmation_mode" "event_confirmation_mode" NOT NULL,
	"income_occurrence_id" integer,
	"transfer_id" integer,
	"primary_transaction_id" integer NOT NULL,
	"secondary_transaction_id" integer,
	"confirmed_amount" numeric(14, 2) NOT NULL,
	"confirmed_date" date,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_key" varchar(240) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "financial_event_evidence" ADD CONSTRAINT "financial_event_evidence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_event_evidence" ADD CONSTRAINT "financial_event_evidence_income_occurrence_id_income_entries_id_fk" FOREIGN KEY ("income_occurrence_id") REFERENCES "public"."income_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_event_evidence" ADD CONSTRAINT "financial_event_evidence_transfer_id_account_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."account_transfers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_event_evidence" ADD CONSTRAINT "financial_event_evidence_primary_transaction_id_imported_transactions_id_fk" FOREIGN KEY ("primary_transaction_id") REFERENCES "public"."imported_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_event_evidence" ADD CONSTRAINT "financial_event_evidence_secondary_transaction_id_imported_transactions_id_fk" FOREIGN KEY ("secondary_transaction_id") REFERENCES "public"."imported_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "financial_event_evidence_user_idx" ON "financial_event_evidence" USING btree ("user_id","event_type");--> statement-breakpoint
CREATE INDEX "financial_event_evidence_income_idx" ON "financial_event_evidence" USING btree ("income_occurrence_id");--> statement-breakpoint
CREATE INDEX "financial_event_evidence_primary_idx" ON "financial_event_evidence" USING btree ("primary_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_event_evidence_key_uq" ON "financial_event_evidence" USING btree ("user_id","event_key");