CREATE TYPE "public"."estimate_type" AS ENUM('fixed', 'typical', 'range', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."income_cadence" AS ENUM('one_time', 'weekly', 'biweekly', 'semimonthly', 'monthly');--> statement-breakpoint
ALTER TYPE "public"."income_status" ADD VALUE 'skipped';--> statement-breakpoint
CREATE TABLE "income_schedule_allocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"schedule_id" integer NOT NULL,
	"account_id" integer NOT NULL,
	"allocation_type" "allocation_type" NOT NULL,
	"value" numeric(14, 2),
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "income_schedules" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"source" varchar(160) NOT NULL,
	"cadence" "income_cadence" NOT NULL,
	"anchor_date" date NOT NULL,
	"expected_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"estimate_type" "estimate_type" DEFAULT 'fixed' NOT NULL,
	"expected_min" numeric(12, 2),
	"expected_max" numeric(12, 2),
	"destination_account_id" integer,
	"day_of_month" integer,
	"day_a" integer,
	"day_b" integer,
	"is_payday" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"end_date" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "income_entries" ADD COLUMN "schedule_id" integer;--> statement-breakpoint
ALTER TABLE "income_entries" ADD COLUMN "estimate_type" "estimate_type" DEFAULT 'fixed' NOT NULL;--> statement-breakpoint
ALTER TABLE "income_entries" ADD COLUMN "expected_min" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "income_entries" ADD COLUMN "expected_max" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "income_schedule_allocations" ADD CONSTRAINT "income_schedule_allocations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_schedule_allocations" ADD CONSTRAINT "income_schedule_allocations_schedule_id_income_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."income_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_schedule_allocations" ADD CONSTRAINT "income_schedule_allocations_account_id_financial_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."financial_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_schedules" ADD CONSTRAINT "income_schedules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_schedules" ADD CONSTRAINT "income_schedules_destination_account_id_financial_accounts_id_fk" FOREIGN KEY ("destination_account_id") REFERENCES "public"."financial_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "income_schedule_allocations_idx" ON "income_schedule_allocations" USING btree ("schedule_id");--> statement-breakpoint
CREATE UNIQUE INDEX "income_schedule_allocations_uq" ON "income_schedule_allocations" USING btree ("schedule_id","account_id");--> statement-breakpoint
CREATE INDEX "income_schedules_user_idx" ON "income_schedules" USING btree ("user_id","active");--> statement-breakpoint
ALTER TABLE "income_entries" ADD CONSTRAINT "income_entries_schedule_id_income_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."income_schedules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "income_entries_schedule_date_uq" ON "income_entries" USING btree ("schedule_id","pay_date") WHERE "income_entries"."schedule_id" IS NOT NULL AND "income_entries"."deleted_at" IS NULL;