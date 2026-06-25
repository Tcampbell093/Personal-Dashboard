CREATE TYPE "public"."movement_kind" AS ENUM('bill_payment', 'bill_payment_reversal');--> statement-breakpoint
CREATE TABLE "account_movements" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"account_id" integer NOT NULL,
	"bill_id" integer,
	"kind" "movement_kind" NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"reversal_of_id" integer,
	"note" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_movements" ADD CONSTRAINT "account_movements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_movements" ADD CONSTRAINT "account_movements_account_id_financial_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."financial_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_movements" ADD CONSTRAINT "account_movements_bill_id_financial_entries_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."financial_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_movements" ADD CONSTRAINT "account_movements_reversal_of_id_account_movements_id_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."account_movements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_movements_user_idx" ON "account_movements" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "account_movements_bill_idx" ON "account_movements" USING btree ("bill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_movements_reversal_uq" ON "account_movements" USING btree ("reversal_of_id") WHERE "account_movements"."reversal_of_id" IS NOT NULL;