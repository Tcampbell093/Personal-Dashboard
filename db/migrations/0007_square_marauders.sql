CREATE TYPE "public"."allocation_type" AS ENUM('fixed', 'percent', 'remainder');--> statement-breakpoint
CREATE TYPE "public"."income_status" AS ENUM('scheduled', 'received', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."transfer_status" AS ENUM('scheduled', 'completed', 'reversed', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."movement_kind" ADD VALUE 'income_received';--> statement-breakpoint
ALTER TYPE "public"."movement_kind" ADD VALUE 'income_reversal';--> statement-breakpoint
ALTER TYPE "public"."movement_kind" ADD VALUE 'transfer_out';--> statement-breakpoint
ALTER TYPE "public"."movement_kind" ADD VALUE 'transfer_in';--> statement-breakpoint
ALTER TYPE "public"."movement_kind" ADD VALUE 'transfer_out_reversal';--> statement-breakpoint
ALTER TYPE "public"."movement_kind" ADD VALUE 'transfer_in_reversal';--> statement-breakpoint
CREATE TABLE "account_transfers" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"from_account_id" integer NOT NULL,
	"to_account_id" integer NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"scheduled_date" date,
	"status" "transfer_status" DEFAULT 'scheduled' NOT NULL,
	"completed_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "income_allocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"income_id" integer NOT NULL,
	"account_id" integer NOT NULL,
	"allocation_type" "allocation_type" NOT NULL,
	"value" numeric(14, 2),
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "account_movements" ADD COLUMN "income_id" integer;--> statement-breakpoint
ALTER TABLE "account_movements" ADD COLUMN "transfer_id" integer;--> statement-breakpoint
ALTER TABLE "income_entries" ADD COLUMN "destination_account_id" integer;--> statement-breakpoint
ALTER TABLE "income_entries" ADD COLUMN "status" "income_status" DEFAULT 'scheduled' NOT NULL;--> statement-breakpoint
ALTER TABLE "income_entries" ADD COLUMN "received_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_transfers" ADD CONSTRAINT "account_transfers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_transfers" ADD CONSTRAINT "account_transfers_from_account_id_financial_accounts_id_fk" FOREIGN KEY ("from_account_id") REFERENCES "public"."financial_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_transfers" ADD CONSTRAINT "account_transfers_to_account_id_financial_accounts_id_fk" FOREIGN KEY ("to_account_id") REFERENCES "public"."financial_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_allocations" ADD CONSTRAINT "income_allocations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_allocations" ADD CONSTRAINT "income_allocations_income_id_income_entries_id_fk" FOREIGN KEY ("income_id") REFERENCES "public"."income_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_allocations" ADD CONSTRAINT "income_allocations_account_id_financial_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."financial_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_transfers_user_idx" ON "account_transfers" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "income_allocations_income_idx" ON "income_allocations" USING btree ("income_id");--> statement-breakpoint
CREATE UNIQUE INDEX "income_allocations_income_account_uq" ON "income_allocations" USING btree ("income_id","account_id");--> statement-breakpoint
ALTER TABLE "account_movements" ADD CONSTRAINT "account_movements_income_id_income_entries_id_fk" FOREIGN KEY ("income_id") REFERENCES "public"."income_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_movements" ADD CONSTRAINT "account_movements_transfer_id_account_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."account_transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_entries" ADD CONSTRAINT "income_entries_destination_account_id_financial_accounts_id_fk" FOREIGN KEY ("destination_account_id") REFERENCES "public"."financial_accounts"("id") ON DELETE no action ON UPDATE no action;