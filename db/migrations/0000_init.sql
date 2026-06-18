CREATE TYPE "public"."bill_status" AS ENUM('scheduled', 'due', 'paid', 'overdue', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."feedback_kind" AS ENUM('save', 'dismiss', 'too_obvious', 'too_expensive', 'too_risky', 'not_enough_time', 'more_like_this', 'would_actually_do', 'acted_on');--> statement-breakpoint
CREATE TYPE "public"."importance" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."interest_status" AS ENUM('new', 'read', 'saved', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('new', 'saved', 'reviewing', 'applying', 'applied', 'interviewing', 'rejected', 'offer', 'dismissed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."obligation_status" AS ENUM('upcoming', 'in_progress', 'done', 'missed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."obligation_type" AS ENUM('appointment', 'meeting', 'work_shift', 'renewal', 'application_deadline', 'payment', 'personal_commitment', 'event', 'other_deadline');--> statement-breakpoint
CREATE TYPE "public"."opportunity_category" AS ENUM('quick_cash', 'resale_flipping', 'arbitrage', 'temporary_demand', 'event_based', 'vendor_opportunity', 'service_opportunity', 'access_opportunity', 'career_opportunity', 'cost_saving_opportunity', 'creative_combination', 'long_shot', 'other');--> statement-breakpoint
CREATE TYPE "public"."opportunity_status" AS ENUM('new', 'saved', 'researching', 'planning', 'acted_on', 'successful', 'unsuccessful', 'dismissed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."priority" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."recurrence" AS ENUM('one_time', 'daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('success', 'failure', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."signal_status" AS ENUM('new', 'reviewed', 'saved', 'used_in_opportunity', 'dismissed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."signal_type" AS ENUM('weather', 'local_event', 'festival', 'vendor_opportunity', 'estate_sale', 'garage_sale', 'auction', 'business_opening', 'business_closing', 'liquidation', 'local_news', 'job_posting', 'grant', 'training_opportunity', 'marketplace_listing', 'construction', 'road_closure', 'community_need', 'holiday', 'convention', 'entertainment', 'technology', 'ai_development', 'other');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('not_started', 'in_progress', 'completed', 'deferred', 'cancelled');--> statement-breakpoint
CREATE TABLE "api_usage_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"provider" varchar(60) NOT NULL,
	"operation" varchar(120),
	"tokens_in" integer,
	"tokens_out" integer,
	"estimated_cost" numeric(10, 4),
	"success" boolean DEFAULT true NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_briefings" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"briefing_date" date NOT NULL,
	"summary" text,
	"most_important_task" text,
	"most_important_obligation" text,
	"most_relevant_opportunity" text,
	"warning" text,
	"generated_by" varchar(20) DEFAULT 'rule_based' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "financial_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" varchar(120) NOT NULL,
	"type" varchar(60) DEFAULT 'checking',
	"current_balance" numeric(14, 2) DEFAULT '0',
	"balance_updated_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "financial_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"recurring_bill_id" integer,
	"name" varchar(160) NOT NULL,
	"kind" varchar(20) DEFAULT 'bill' NOT NULL,
	"due_date" date,
	"expected_amount" numeric(12, 2) NOT NULL,
	"actual_amount" numeric(12, 2),
	"minimum_payment" numeric(12, 2),
	"status" "bill_status" DEFAULT 'scheduled' NOT NULL,
	"paid_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "income_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"source" varchar(160) NOT NULL,
	"expected_amount" numeric(12, 2) NOT NULL,
	"actual_amount" numeric(12, 2),
	"pay_date" date NOT NULL,
	"recurrence" "recurrence" DEFAULT 'biweekly' NOT NULL,
	"is_payday" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "intelligence_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"ai_automation_enabled" boolean DEFAULT false NOT NULL,
	"kill_switch" boolean DEFAULT false NOT NULL,
	"daily_api_call_limit" integer DEFAULT 50,
	"monthly_api_call_limit" integer DEFAULT 500,
	"daily_web_search_limit" integer DEFAULT 25,
	"monthly_cost_limit" numeric(10, 2) DEFAULT '10.00',
	"last_successful_run" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "intelligence_settings_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "interest_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"topic_id" integer,
	"title" varchar(280) NOT NULL,
	"summary" text,
	"source" varchar(160),
	"source_url" text,
	"published_date" date,
	"why_it_matters" text,
	"relevance_score" integer,
	"status" "interest_status" DEFAULT 'new' NOT NULL,
	"is_mock" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "interest_topics" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" varchar(120) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"title" varchar(280) NOT NULL,
	"company" varchar(200),
	"location" text,
	"salary_min" numeric(12, 2),
	"salary_max" numeric(12, 2),
	"employment_type" varchar(60),
	"work_arrangement" varchar(60),
	"description" text,
	"requirements" text,
	"source" varchar(120),
	"source_url" text,
	"posted_date" date,
	"application_deadline" date,
	"match_score" integer,
	"why_it_matches" text,
	"possible_concerns" text,
	"status" "job_status" DEFAULT 'new' NOT NULL,
	"is_mock" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "obligations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"title" varchar(280) NOT NULL,
	"type" "obligation_type" DEFAULT 'appointment' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"start_time" time,
	"location" text,
	"description" text,
	"importance" "importance" DEFAULT 'medium' NOT NULL,
	"reminder_date" date,
	"status" "obligation_status" DEFAULT 'upcoming' NOT NULL,
	"source" varchar(120) DEFAULT 'manual',
	"external_calendar_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"title" varchar(280) NOT NULL,
	"summary" text,
	"category" "opportunity_category" DEFAULT 'other' NOT NULL,
	"what_is_happening" text,
	"creative_angle" text,
	"why_it_fits" text,
	"time_window_start" date,
	"time_window_end" date,
	"startup_cost" numeric(12, 2),
	"estimated_effort" "importance",
	"estimated_risk" "importance",
	"confidence_score" integer,
	"potential_value" numeric(12, 2),
	"open_questions" jsonb DEFAULT '[]'::jsonb,
	"possible_obstacles" jsonb DEFAULT '[]'::jsonb,
	"next_actions" jsonb DEFAULT '[]'::jsonb,
	"source_links" jsonb DEFAULT '[]'::jsonb,
	"status" "opportunity_status" DEFAULT 'new' NOT NULL,
	"expiration_date" date,
	"generated_by" varchar(20) DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "opportunity_feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"opportunity_id" integer NOT NULL,
	"kind" "feedback_kind" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_signals" (
	"id" serial PRIMARY KEY NOT NULL,
	"opportunity_id" integer NOT NULL,
	"signal_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_bills" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" varchar(160) NOT NULL,
	"expected_amount" numeric(12, 2) NOT NULL,
	"minimum_payment" numeric(12, 2),
	"due_day_of_month" integer,
	"recurrence" "recurrence" DEFAULT 'monthly' NOT NULL,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "scheduled_run_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"job_name" varchar(120) NOT NULL,
	"status" "run_status" NOT NULL,
	"detail" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "signal_sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"name" varchar(160) NOT NULL,
	"base_url" text,
	"kind" varchar(60),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"source_id" integer,
	"title" varchar(280) NOT NULL,
	"summary" text,
	"type" "signal_type" DEFAULT 'other' NOT NULL,
	"source_name" varchar(160),
	"source_url" text,
	"normalized_url" text,
	"external_id" varchar(255),
	"content_hash" varchar(64),
	"duplicate_of" integer,
	"is_duplicate" boolean DEFAULT false NOT NULL,
	"location" text,
	"event_date" date,
	"start_date" date,
	"end_date" date,
	"expiration_date" date,
	"discovered_at" timestamp with time zone DEFAULT now(),
	"cost" numeric(12, 2),
	"estimated_attendance" integer,
	"raw_notes" text,
	"confirmed_facts" text,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"relevance_score" integer,
	"urgency_score" integer,
	"confidence_score" integer,
	"status" "signal_status" DEFAULT 'new' NOT NULL,
	"is_mock" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"title" varchar(280) NOT NULL,
	"description" text,
	"due_date" date,
	"due_time" time,
	"priority" "priority" DEFAULT 'medium' NOT NULL,
	"status" "task_status" DEFAULT 'not_started' NOT NULL,
	"category" varchar(80),
	"recurrence" "recurrence" DEFAULT 'one_time' NOT NULL,
	"notes" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"home_area" text,
	"work_area" text,
	"search_radius_miles" integer DEFAULT 25,
	"transportation" text,
	"weekly_availability" jsonb,
	"startup_budget" numeric(12, 2),
	"max_risk" "importance" DEFAULT 'medium',
	"skills" jsonb DEFAULT '[]'::jsonb,
	"work_experience" text,
	"interests" jsonb DEFAULT '[]'::jsonb,
	"career_preferences" text,
	"desired_salary_min" numeric(12, 2),
	"desired_salary_max" numeric(12, 2),
	"max_commute_minutes" integer,
	"opportunity_interests" jsonb DEFAULT '[]'::jsonb,
	"excluded_opportunity_categories" jsonb DEFAULT '[]'::jsonb,
	"monitored_areas" jsonb DEFAULT '[]'::jsonb,
	"news_topics" jsonb DEFAULT '[]'::jsonb,
	"entertainment_topics" jsonb DEFAULT '[]'::jsonb,
	"technology_topics" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "user_preferences_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar(320) NOT NULL,
	"name" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "api_usage_logs" ADD CONSTRAINT "api_usage_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_briefings" ADD CONSTRAINT "daily_briefings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_accounts" ADD CONSTRAINT "financial_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_entries" ADD CONSTRAINT "financial_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_entries" ADD CONSTRAINT "financial_entries_recurring_bill_id_recurring_bills_id_fk" FOREIGN KEY ("recurring_bill_id") REFERENCES "public"."recurring_bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_entries" ADD CONSTRAINT "income_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intelligence_settings" ADD CONSTRAINT "intelligence_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_items" ADD CONSTRAINT "interest_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_items" ADD CONSTRAINT "interest_items_topic_id_interest_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."interest_topics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_topics" ADD CONSTRAINT "interest_topics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_feedback" ADD CONSTRAINT "opportunity_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_feedback" ADD CONSTRAINT "opportunity_feedback_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_signals" ADD CONSTRAINT "opportunity_signals_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_signals" ADD CONSTRAINT "opportunity_signals_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_bills" ADD CONSTRAINT "recurring_bills_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_run_logs" ADD CONSTRAINT "scheduled_run_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_sources" ADD CONSTRAINT "signal_sources_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_source_id_signal_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."signal_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_usage_provider_idx" ON "api_usage_logs" USING btree ("provider","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "briefing_user_date_uq" ON "daily_briefings" USING btree ("user_id","briefing_date");--> statement-breakpoint
CREATE INDEX "financial_entries_user_due_idx" ON "financial_entries" USING btree ("user_id","due_date");--> statement-breakpoint
CREATE INDEX "financial_entries_status_idx" ON "financial_entries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "income_entries_user_date_idx" ON "income_entries" USING btree ("user_id","pay_date");--> statement-breakpoint
CREATE INDEX "interest_items_user_idx" ON "interest_items" USING btree ("user_id","topic_id");--> statement-breakpoint
CREATE INDEX "jobs_user_status_idx" ON "jobs" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "obligations_user_start_idx" ON "obligations" USING btree ("user_id","start_date");--> statement-breakpoint
CREATE INDEX "obligations_status_idx" ON "obligations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "opportunities_user_status_idx" ON "opportunities" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "opp_signal_uq" ON "opportunity_signals" USING btree ("opportunity_id","signal_id");--> statement-breakpoint
CREATE INDEX "recurring_bills_user_idx" ON "recurring_bills" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "run_logs_job_idx" ON "scheduled_run_logs" USING btree ("job_name","started_at");--> statement-breakpoint
CREATE INDEX "signals_user_status_idx" ON "signals" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "signals_type_idx" ON "signals" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "signals_user_normurl_uq" ON "signals" USING btree ("user_id","normalized_url") WHERE "signals"."normalized_url" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "signals_user_hash_uq" ON "signals" USING btree ("user_id","content_hash") WHERE "signals"."content_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tasks_user_status_idx" ON "tasks" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "tasks_due_idx" ON "tasks" USING btree ("due_date");