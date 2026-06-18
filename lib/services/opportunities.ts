/* Opportunities service. Mirrors the tasks pattern. */

import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { opportunities } from "@/db/schema";
import type { OpportunityView } from "@/lib/types";

export type NewOpportunity = typeof opportunities.$inferInsert;
export type OpportunityRow = typeof opportunities.$inferSelect;

export const OPPORTUNITY_CATEGORIES = [
  "quick_cash",
  "resale_flipping",
  "arbitrage",
  "temporary_demand",
  "event_based",
  "vendor_opportunity",
  "service_opportunity",
  "access_opportunity",
  "career_opportunity",
  "cost_saving_opportunity",
  "creative_combination",
  "long_shot",
  "other",
] as const;

export const OPPORTUNITY_STATUSES = [
  "new",
  "saved",
  "researching",
  "planning",
  "acted_on",
  "successful",
  "unsuccessful",
  "dismissed",
  "expired",
] as const;

export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;

const num = (v: string | null): number | null => (v == null ? null : parseFloat(v));

export function toOpportunityViews(rows: OpportunityRow[]): OpportunityView[] {
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    summary: r.summary,
    category: r.category,
    timeWindowEnd: r.timeWindowEnd,
    confidenceScore: r.confidenceScore,
    potentialValue: num(r.potentialValue),
    estimatedRisk: r.estimatedRisk,
    status: r.status,
  }));
}

export async function listOpportunities(userId: number): Promise<OpportunityRow[]> {
  return db
    .select()
    .from(opportunities)
    .where(and(eq(opportunities.userId, userId), isNull(opportunities.deletedAt)))
    .orderBy(desc(opportunities.createdAt));
}

export async function createOpportunity(
  input: NewOpportunity,
): Promise<OpportunityRow> {
  const [row] = await db.insert(opportunities).values(input).returning();
  return row;
}

export async function updateOpportunity(
  userId: number,
  id: number,
  patch: Partial<NewOpportunity>,
): Promise<OpportunityRow | null> {
  const [row] = await db
    .update(opportunities)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(opportunities.id, id),
        eq(opportunities.userId, userId),
        isNull(opportunities.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

export async function deleteOpportunity(userId: number, id: number) {
  return updateOpportunity(userId, id, {
    deletedAt: new Date(),
  } as Partial<NewOpportunity>);
}
