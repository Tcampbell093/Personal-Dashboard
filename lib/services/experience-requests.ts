/* Experience-request service — Build 1 (manual lifecycle).
 * All DB access for experience requests goes through here; routes call these.
 * Mirrors the established service pattern (owner-scoped, soft-delete, mappers). */

import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { experienceRequests, userPreferences } from "@/db/schema";
import type { ExperienceRecommendation, ExperienceRequestView } from "@/lib/types";
import type { InterpretationResult, AiUsage } from "@/lib/ai/provider";

// Request statuses from which owner-triggered recommendation generation is allowed.
export const RECOMMENDABLE_STATUSES = ["draft", "interpreted", "recommendations_ready"] as const;

// Constraint fields the AI interprets — editing any of these clears AI provenance.
export const INTERPRETED_CONSTRAINT_FIELDS = [
  "availableDate",
  "availableTimeText",
  "budgetMax",
  "startingLocation",
  "maxTravelMiles",
  "maxTravelMinutes",
  "energyLevel",
  "desiredFeeling",
  "maxPhysicalDifficulty",
  "interests",
  "exclusions",
] as const;

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
    interpretationSource: r.interpretationSource,
    recommendations: r.recommendations ?? [],
    recommendationSource: r.recommendationSource,
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

/* --- AI interpretation (Build 2A) ---------------------------------------- */

/** Persist a validated AI interpretation onto the request: overwrite the
 * constraint columns, record provenance (source=ai + provider + exact model),
 * and set status `interpreted`. */
export async function applyInterpretation(
  userId: number,
  id: number,
  result: InterpretationResult,
  usage: AiUsage,
): Promise<ExperienceRequestRow | null> {
  return updateRequest(userId, id, {
    availableDate: result.availableDate,
    availableTimeText: result.availableTimeText,
    budgetMax: result.budgetMax == null ? null : String(result.budgetMax),
    startingLocation: result.startingLocation,
    maxTravelMiles: result.maxTravelMiles,
    maxTravelMinutes: result.maxTravelMinutes,
    energyLevel: result.energyLevel as never,
    desiredFeeling: result.desiredFeeling,
    maxPhysicalDifficulty: result.maxPhysicalDifficulty as never,
    interests: result.interests,
    exclusions: result.exclusions,
    interpretationSource: "ai",
    interpretationProvider: usage.provider,
    interpretationModel: usage.model,
    status: "interpreted",
  } as Partial<NewExperienceRequest>);
}

/* --- AI recommendations (Build 2B.1) ------------------------------------- */

/** Persist a validated recommendation batch: overwrite the recommendations
 * column, record provenance, and set status `recommendations_ready`. Replaces
 * any prior batch wholesale (regeneration). */
export async function applyRecommendations(
  userId: number,
  id: number,
  batch: ExperienceRecommendation[],
  usage: AiUsage,
): Promise<ExperienceRequestRow | null> {
  return updateRequest(userId, id, {
    recommendations: batch,
    recommendationSource: "ai",
    recommendationProvider: usage.provider,
    recommendationModel: usage.model,
    status: "recommendations_ready",
  } as Partial<NewExperienceRequest>);
}

/** Clear a stored recommendation batch + its provenance and return the request
 * to `interpreted` (constraints remain). Used by clear-on-edit when request text
 * or any interpreted constraint changes. Never calls AI. */
export async function clearRecommendations(
  userId: number,
  id: number,
): Promise<ExperienceRequestRow | null> {
  return updateRequest(userId, id, {
    recommendations: [],
    recommendationSource: null,
    recommendationProvider: null,
    recommendationModel: null,
    status: "interpreted",
  } as Partial<NewExperienceRequest>);
}

/** Deterministic, human-readable summary of the current constraints (no AI). */
export function interpretationSummary(r: ExperienceRequestView): string {
  const parts: string[] = [];
  if (r.availableTimeText) parts.push(r.availableTimeText);
  else if (r.availableDate) parts.push(r.availableDate);
  if (r.budgetMax != null) parts.push(`within $${r.budgetMax}`);
  if (r.maxTravelMinutes != null) parts.push(`≤ ${r.maxTravelMinutes} min`);
  if (r.maxTravelMiles != null) parts.push(`≤ ${r.maxTravelMiles} mi`);
  if (r.energyLevel) parts.push(`${r.energyLevel} energy`);
  if (r.maxPhysicalDifficulty) parts.push(`≤ ${r.maxPhysicalDifficulty} difficulty`);
  if (r.desiredFeeling) parts.push(`feel ${r.desiredFeeling}`);
  if (r.startingLocation) parts.push(`from ${r.startingLocation}`);
  if (r.interests.length) parts.push(`interests: ${r.interests.join(", ")}`);
  if (r.exclusions.length) parts.push(`avoid: ${r.exclusions.join(", ")}`);
  return parts.length
    ? parts.join(" · ")
    : "No specific constraints understood — add details under Review details.";
}
