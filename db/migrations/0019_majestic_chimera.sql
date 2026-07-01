CREATE TABLE "financial_insight_dismissals" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"insight_key" varchar(240) NOT NULL,
	"insight_type" varchar(60) NOT NULL,
	"period_key" varchar(40) NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "financial_insight_dismissals" ADD CONSTRAINT "financial_insight_dismissals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "financial_insight_dismissals_user_idx" ON "financial_insight_dismissals" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_insight_dismissals_key_uq" ON "financial_insight_dismissals" USING btree ("user_id","insight_key");