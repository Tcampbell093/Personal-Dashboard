DROP INDEX "credit_inquiries_uq";--> statement-breakpoint
DROP INDEX "credit_score_snapshots_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "credit_inquiries_uq" ON "credit_inquiries" USING btree ("user_id","creditor_name","inquiry_date","inquiry_type") WHERE "credit_inquiries"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_score_snapshots_uq" ON "credit_score_snapshots" USING btree ("user_id","source","scoring_model","as_of_date","score") WHERE "credit_score_snapshots"."deleted_at" is null;