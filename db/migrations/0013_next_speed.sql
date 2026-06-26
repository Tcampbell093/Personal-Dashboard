ALTER TABLE "provider_accounts" DROP CONSTRAINT "provider_accounts_connection_id_financial_connections_id_fk";
--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_connection_id_financial_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."financial_connections"("id") ON DELETE no action ON UPDATE no action;