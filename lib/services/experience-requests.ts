/* Experience-request service — Build 1 (manual lifecycle).
 * All DB access for experience requests goes through here; routes call these.
 * Mirrors the established service pattern (owner-scoped, soft-delete, mappers). */

import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { experienceRequests, userPreferences } from "@/db/schema";
import type { ExperienceRequestView } from "@/lib/types";

export type NewExperienceRequest = typeof experienceRequests.$inferInsert;
export type ExperienceRequestRow = typeof experienceRequests.$inferSelect;

export const ENERGY_LEVELS = ["low", "medium", "high"] as const;
export const PHYSICAL_DIFFICULTIES = ["easy", "moderate", "challenging"] as const;

const num = (v: string | null): number | null => (v == null ? null : parseFloat(v));

export function toRequestView(r: ExperienceRequestRow): ExperienceRequestView {
  return {
    id: r.id,
    requestText: r.requestText,
    availableDate: r.availableDate,
    availableTimeText: r.availableTimeText,
    budgetMax: num(r.budgetMax),
    startingLocation: r.startingLocation,
    maxTravelMiles: r.maxTravelMiles,
    maxTravelMinutes: r.maxTravelMinutes,
    energyLevel: r.energyLevel,
    desiredFeeling: r.desiredFeeling,
    maxPhysicalDifficulty: r.maxPhysicalDifficulty,
    interests: r.interests ?? [],
    exclusions: r.exclusions ?? [],
    status: r.status,
  };
}

export function toRequestViews(rows: ExperienceRequestRow[]): ExperienceRequestView[] {
  return rows.map(toRequestView);
}

/** Read-only lookup of the owner's saved home area, for request prefill.
 * NOTE: prefill only — editing a request's location must never write back here. */
export async function getHomeArea(userId: number): Promise<string | null> {
  const [row] = await db
    .select({ homeArea: userPreferences.homeArea })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  return row?.homeArea ?? null;
}

export async function listRequests(userId: number): Promise<ExperienceRequestRow[]> {
  return db
    .select()
    .from(experienceRequests)
    .where(and(eq(experienceRequests.userId, userId), isNull(experienceRequests.deletedAt)))
    .orderBy(desc(experienceRequests.createdAt));
}

export async function getRequest(
  userId: number,
  id: number,
): Promise<ExperienceRequestRow | null> {
  const [row] = await db
    .select()
    .from(experienceRequests)
    .where(
      and(
        eq(experienceRequests.id, id),
        eq(experienceRequests.userId, userId),
        isNull(experienceRequests.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function createRequest(
  input: NewExperienceRequest,
): Promise<ExperienceRequestRow> {
  const [row] = await db.insert(experienceRequests).values(input).returning();
  return row;
}

export async function updateRequest(
  userId: number,
  id: number,
  patch: Partial<NewExperienceRequest>,
): Promise<ExperienceRequestRow | null> {
  const [row] = await db
    .update(experienceRequests)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(experienceRequests.id, id),
        eq(experienceRequests.userId, userId),
        isNull(experienceRequests.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/** Soft delete — never a hard delete. */
export async function deleteRequest(userId: number, id: number) {
  return updateRequest(userId, id, {
    deletedAt: new Date(),
  } as Partial<NewExperienceRequest>);
}
