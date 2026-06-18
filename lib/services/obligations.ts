/* Obligations service — mirrors lib/services/tasks.ts.
 * All DB access for obligations goes through here. Route handlers and the
 * dashboard loader call these functions; UI components never touch the DB. */

import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { obligations } from "@/db/schema";
import type { ObligationView } from "@/lib/types";

export type NewObligation = typeof obligations.$inferInsert;
export type ObligationRow = typeof obligations.$inferSelect;

/* Validation enums — shared by the API routes. Kept here (not in route.ts) so
 * route files only export HTTP handlers, as Next.js requires. */
export const OBLIGATION_TYPES = [
  "appointment",
  "meeting",
  "work_shift",
  "renewal",
  "application_deadline",
  "payment",
  "personal_commitment",
  "event",
  "other_deadline",
] as const;
export const IMPORTANCE = ["low", "medium", "high", "critical"] as const;
export const OBLIGATION_STATUSES = [
  "upcoming",
  "in_progress",
  "done",
  "missed",
  "cancelled",
] as const;

/* Map DB rows -> the UI view model. As with tasks, the Neon HTTP driver returns
 * `date` columns as "YYYY-MM-DD" and `time` as "HH:MM:SS"; trim seconds. */
export function toObligationViews(rows: ObligationRow[]): ObligationView[] {
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    type: r.type,
    startDate: r.startDate,
    startTime: r.startTime ? r.startTime.slice(0, 5) : null,
    location: r.location,
    importance: r.importance,
    status: r.status,
  }));
}

/** List live (non-soft-deleted) obligations for a user, soonest first. */
export async function listObligations(userId: number): Promise<ObligationRow[]> {
  return db
    .select()
    .from(obligations)
    .where(and(eq(obligations.userId, userId), isNull(obligations.deletedAt)))
    .orderBy(asc(obligations.startDate));
}

export async function createObligation(input: NewObligation): Promise<ObligationRow> {
  const [row] = await db.insert(obligations).values(input).returning();
  return row;
}

export async function updateObligation(
  userId: number,
  id: number,
  patch: Partial<NewObligation>,
): Promise<ObligationRow | null> {
  const [row] = await db
    .update(obligations)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(obligations.id, id),
        eq(obligations.userId, userId),
        isNull(obligations.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

export async function completeObligation(userId: number, id: number) {
  return updateObligation(userId, id, { status: "done" });
}

/** Soft delete — never a hard delete in Phase 1. */
export async function deleteObligation(userId: number, id: number) {
  return updateObligation(userId, id, { deletedAt: new Date() } as Partial<NewObligation>);
}
