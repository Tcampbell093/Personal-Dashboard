CREATE TYPE "public"."category_assignment_source" AS ENUM('owner', 'merchant_rule', 'deterministic_suggestion');--> statement-breakpoint
CREATE TYPE "public"."category_assignment_status" AS ENUM('suggested', 'confirmed', 'rejected', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."merchant_rule_behavior" AS ENUM('suggest', 'auto');--> statement-breakpoint
CREATE TYPE "public"."merchant_rule_match_type" AS ENUM('exact_normalized_merchant', 'description_contains', 'description_starts_with');--> statement-breakpoint
CREATE TYPE "public"."transaction_category_kind" AS ENUM('expense', 'income', 'transfer', 'neutral');--> statement-breakpoint
CREATE TABLE "merchant_category_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" varchar(120) NOT NULL,
	"match_type" "merchant_rule_match_type" DEFAULT 'exact_normalized_merchant' NOT NULL,
	"match_value" varchar(200) NOT NULL,
	"normalized_match_value" varchar(200) NOT NULL,
	"category_id" integer NOT NULL,
	"behavior" "merchant_rule_behavior" DEFAULT 'suggest' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"apply_to_existing" boolean DEFAULT false NOT NULL,
	"created_from_transaction_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "transaction_categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" varchar(80) NOT NULL,
	"slug" varchar(80) NOT NULL,
	"kind" "transaction_category_kind" DEFAULT 'expense' NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "transaction_category_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"transaction_id" integer NOT NULL,
	"category_id" integer NOT NULL,
	"source" "category_assignment_source" NOT NULL,
	"status" "category_assignment_status" NOT NULL,
	"rule_id" integer,
	"confidence" integer,
	"reason_codes" text DEFAULT '[]' NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "merchant_category_rules" ADD CONSTRAINT "merchant_category_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_category_rules" ADD CONSTRAINT "merchant_category_rules_category_id_transaction_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."transaction_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_category_rules" ADD CONSTRAINT "merchant_category_rules_created_from_transaction_id_imported_transactions_id_fk" FOREIGN KEY ("created_from_transaction_id") REFERENCES "public"."imported_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_categories" ADD CONSTRAINT "transaction_categories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_category_assignments" ADD CONSTRAINT "transaction_category_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_category_assignments" ADD CONSTRAINT "transaction_category_assignments_transaction_id_imported_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."imported_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_category_assignments" ADD CONSTRAINT "transaction_category_assignments_category_id_transaction_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."transaction_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merchant_category_rules_user_idx" ON "merchant_category_rules" USING btree ("user_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_category_rules_active_uq" ON "merchant_category_rules" USING btree ("user_id","match_type","normalized_match_value") WHERE is_active;--> statement-breakpoint
CREATE INDEX "transaction_categories_user_idx" ON "transaction_categories" USING btree ("user_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_categories_user_slug_uq" ON "transaction_categories" USING btree ("user_id","slug");--> statement-breakpoint
CREATE INDEX "transaction_category_assignments_user_idx" ON "transaction_category_assignments" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "transaction_category_assignments_txn_idx" ON "transaction_category_assignments" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_category_assignments_confirmed_uq" ON "transaction_category_assignments" USING btree ("transaction_id") WHERE status = 'confirmed';--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_category_assignments_suggested_uq" ON "transaction_category_assignments" USING btree ("transaction_id") WHERE status = 'suggested';