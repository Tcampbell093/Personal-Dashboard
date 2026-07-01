CREATE TABLE "credit_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"account_type" varchar(30) NOT NULL,
	"name" varchar(120) NOT NULL,
	"issuer" varchar(120),
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"is_revolving" boolean DEFAULT false NOT NULL,
	"credit_limit" numeric(14, 2),
	"current_balance" numeric(14, 2) DEFAULT '0' NOT NULL,
	"minimum_payment" numeric(14, 2),
	"interest_rate" numeric(6, 3),
	"opened_date" date,
	"closed_date" date,
	"statement_date" date,
	"payment_due_date" date,
	"last_reported_date" date,
	"is_authorized_user" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "credit_collections" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"collector_name" varchar(160) NOT NULL,
	"original_creditor" varchar(160),
	"reported_balance" numeric(14, 2) DEFAULT '0' NOT NULL,
	"status" varchar(20) DEFAULT 'reported' NOT NULL,
	"date_opened" date,
	"date_reported" date,
	"last_updated_date" date,
	"validation_status" varchar(24) DEFAULT 'not_requested' NOT NULL,
	"settlement_offer" numeric(14, 2),
	"pay_for_delete_requested" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "credit_goals" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"goal_type" varchar(30) NOT NULL,
	"target_value" numeric(14, 2) NOT NULL,
	"target_date" date,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"priority" varchar(8) DEFAULT 'medium' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "credit_inquiries" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"creditor_name" varchar(160) NOT NULL,
	"inquiry_date" date NOT NULL,
	"bureau" varchar(40),
	"inquiry_type" varchar(8) DEFAULT 'hard' NOT NULL,
	"purpose" varchar(120),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "credit_late_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"credit_account_id" integer NOT NULL,
	"days_late" integer NOT NULL,
	"reported_date" date NOT NULL,
	"amount_past_due" numeric(14, 2),
	"status" varchar(16) DEFAULT 'reported' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "credit_score_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"score" integer NOT NULL,
	"source" varchar(40) NOT NULL,
	"bureau" varchar(40),
	"scoring_model" varchar(60),
	"as_of_date" date NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "credit_accounts" ADD CONSTRAINT "credit_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_collections" ADD CONSTRAINT "credit_collections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_goals" ADD CONSTRAINT "credit_goals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_inquiries" ADD CONSTRAINT "credit_inquiries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_late_payments" ADD CONSTRAINT "credit_late_payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_late_payments" ADD CONSTRAINT "credit_late_payments_credit_account_id_credit_accounts_id_fk" FOREIGN KEY ("credit_account_id") REFERENCES "public"."credit_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_score_snapshots" ADD CONSTRAINT "credit_score_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_accounts_user_idx" ON "credit_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "credit_collections_user_idx" ON "credit_collections" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "credit_goals_user_idx" ON "credit_goals" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "credit_inquiries_user_idx" ON "credit_inquiries" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_inquiries_uq" ON "credit_inquiries" USING btree ("user_id","creditor_name","inquiry_date","inquiry_type");--> statement-breakpoint
CREATE INDEX "credit_late_payments_user_idx" ON "credit_late_payments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "credit_late_payments_account_idx" ON "credit_late_payments" USING btree ("credit_account_id");--> statement-breakpoint
CREATE INDEX "credit_score_snapshots_user_idx" ON "credit_score_snapshots" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_score_snapshots_uq" ON "credit_score_snapshots" USING btree ("user_id","source","scoring_model","as_of_date","score");