CREATE TYPE "public"."match_confidence" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."match_suggestion_status" AS ENUM('pending', 'confirmed', 'rejected', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."match_suggestion_type" AS ENUM('bill_payment', 'income_receipt', 'transfer_pair');--> statement-breakpoint
CREATE TABLE "transaction_match_suggestions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"suggestion_type" "match_suggestion_type" NOT NULL,
	"status" "match_suggestion_status" DEFAULT 'pending' NOT NULL,
	"primary_transaction_id" integer NOT NULL,
	"secondary_transaction_id" integer,
	"bill_id" integer,
	"income_occurrence_id" integer,
	"transfer_id" integer,
	"score" integer NOT NULL,
	"confidence" "match_confidence" NOT NULL,
	"reason_codes" text NOT NULL,
	"amount_difference" numeric(14, 2),
	"date_difference_days" integer,
	"match_key" varchar(240) NOT NULL,
	"reviewed_at" timestamp with time zone,
	"rejection_reason" varchar(300),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "transaction_match_suggestions" ADD CONSTRAINT "transaction_match_suggestions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_match_suggestions" ADD CONSTRAINT "transaction_match_suggestions_primary_transaction_id_imported_transactions_id_fk" FOREIGN KEY ("primary_transaction_id") REFERENCES "public"."imported_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_match_suggestions" ADD CONSTRAINT "transaction_match_suggestions_secondary_transaction_id_imported_transactions_id_fk" FOREIGN KEY ("secondary_transaction_id") REFERENCES "public"."imported_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_match_suggestions" ADD CONSTRAINT "transaction_match_suggestions_bill_id_financial_entries_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."financial_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_match_suggestions" ADD CONSTRAINT "transaction_match_suggestions_income_occurrence_id_income_entries_id_fk" FOREIGN KEY ("income_occurrence_id") REFERENCES "public"."income_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_match_suggestions" ADD CONSTRAINT "transaction_match_suggestions_transfer_id_account_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."account_transfers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transaction_match_suggestions_user_status_idx" ON "transaction_match_suggestions" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "transaction_match_suggestions_primary_idx" ON "transaction_match_suggestions" USING btree ("primary_transaction_id");--> statement-breakpoint
CREATE INDEX "transaction_match_suggestions_type_idx" ON "transaction_match_suggestions" USING btree ("suggestion_type");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_match_suggestions_key_uq" ON "transaction_match_suggestions" USING btree ("user_id","match_key");