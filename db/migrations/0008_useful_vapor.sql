ALTER TYPE "public"."movement_kind" ADD VALUE 'reconcile_adjustment';--> statement-breakpoint
ALTER TYPE "public"."movement_kind" ADD VALUE 'reconcile_reversal';--> statement-breakpoint
ALTER TABLE "account_movements" ADD COLUMN "prior_balance" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "account_movements" ADD COLUMN "new_balance" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "financial_accounts" ADD COLUMN "last_reconciled_at" timestamp with time zone;