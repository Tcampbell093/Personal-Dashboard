ALTER TABLE "income_entries" ADD COLUMN "scheduled_for" date;--> statement-breakpoint
ALTER TABLE "income_entries" ADD COLUMN "is_overridden" boolean DEFAULT false NOT NULL;