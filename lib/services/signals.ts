/* Signals service — local-intelligence inbox. Mirrors the tasks pattern. */

import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { signals } from "@/db/schema";
import type { SignalView } from "@/lib/types";

export type NewSignal = typeof signals.$inferInsert;
export type SignalRow = typeof signals.$inferSelect;

export const SIGNAL_TYPES = [
  "weather",
  "local_event",
  "festival",
  "vendor_opportunity",
  "estate_sale",
  "garage_sale",
  "auction",
  "business_opening",
  "business_closing",
  "liquidation",
  "local_news",
  "job_posting",
  "grant",
  "training_opportunity",
  "marketplace_listing",
  "construction",
  "road_closure",
  "community_need",
  "holiday",
  "convention",
  "entertainment",
  "technology",
  "ai_development",
  "other",
] as const;

export const SIGNAL_STATUSES = [
  "new",
  "reviewed",
  "saved",
  "used_in_opportunity",
  "dismissed",
  "expired",
] as const;

export function toSignalViews(rows: SignalRow[]): SignalView[] {
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    type: r.type,
    location: r.location,
    eventDate: r.eventDate,
    expirationDate: r.expirationDate,
    urgencyScore: r.urgencyScore,
    relevanceScore: r.relevanceScore,
    status: r.status,
    isMock: r.isMock,
  }));
}

export async function listSignals(userId: number): Promise<SignalRow[]> {
  return db
    .select()
    .from(signals)
    .where(and(eq(signals.userId, userId), isNull(signals.deletedAt)))
    .orderBy(desc(signals.createdAt));
}

export async function createSignal(input: NewSignal): Promise<SignalRow> {
  const [row] = await db.insert(signals).values(input).returning();
  return row;
}

export async function updateSignal(
  userId: number,
  id: number,
  patch: Partial<NewSignal>,
): Promise<SignalRow | null> {
  const [row] = await db
    .update(signals)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(signals.id, id), eq(signals.userId, userId), isNull(signals.deletedAt)))
    .returning();
  return row ?? null;
}

export async function deleteSignal(userId: number, id: number) {
  return updateSignal(userId, id, { deletedAt: new Date() } as Partial<NewSignal>);
}
