/* Experience service — Build 1 (manual lifecycle).
 * Owns server-side XP calculation, status-transition rules, and the
 * duplicate-safe creation of a planned experience from a request. */

import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { experiences, experienceRequests } from "@/db/schema";
import type {
  ExperienceView,
  ExperienceXpSummary,
  ExperienceStatus,
  PhysicalDifficulty,
} from "@/lib/types";

export type NewExperience = typeof experiences.$inferInsert;
export type ExperienceRow = typeof experiences.$inferSelect;

export const RESOLVED_STATUSES = ["completed", "cancelled", "not_completed"] as const;
export type ResolvedStatus = (typeof RESOLVED_STATUSES)[number];

/** Business-rule error carrying the HTTP status the route should return. */
export class ExperienceError extends Error {
  constructor(
    public httpStatus: number,
    message: string,
  ) {
    super(message);
  }
}

/** Server-authoritative XP. Meaningful only matters when completed. */
export function computeXp(status: ExperienceStatus, meaningful: boolean): number {
  if (status === "completed") return meaningful ? 15 : 10;
  return 0;
}

const num = (v: string | null): number | null => (v == null ? null : parseFloat(v));
const money = (v: number | null | undefined): string | null =>
  v == null ? null : String(v);

export function toExperienceView(r: ExperienceRow): ExperienceView {
  return {
    id: r.id,
    requestId: r.requestId,
    title: r.title,
    description: r.description,
    plannedDate: r.plannedDate,
    plannedTimeText: r.plannedTimeText,
    locationText: r.locationText,
    expectedCost: num(r.expectedCost),
    actualCost: num(r.actualCost),
    expectedDurationMinutes: r.expectedDurationMinutes,
    physicalDifficulty: r.physicalDifficulty,
    desiredFeeling: r.desiredFeeling,
    notes: r.notes,
    status: r.status,
    nonCompletionReason: r.nonCompletionReason,
    rating: r.rating,
    reflection: r.reflection,
    meaningfulExperience: r.meaningfulExperience,
    adventureXp: r.adventureXp,
    resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
  };
}

export function toExperienceViews(rows: ExperienceRow[]): ExperienceView[] {
  return rows.map(toExperienceView);
}

async function getOwned(userId: number, id: number): Promise<ExperienceRow | null> {
  const [row] = await db
    .select()
    .from(experiences)
    .where(
      and(eq(experiences.id, id), eq(experiences.userId, userId), isNull(experiences.deletedAt)),
    )
    .limit(1);
  return row ?? null;
}

export async function listPlanned(userId: number): Promise<ExperienceRow[]> {
  return db
    .select()
    .from(experiences)
    .where(
      and(
        eq(experiences.userId, userId),
        eq(experiences.status, "planned"),
        isNull(experiences.deletedAt),
      ),
    )
    .orderBy(desc(experiences.createdAt));
}

export async function listHistory(userId: number): Promise<ExperienceRow[]> {
  const rows = await db
    .select()
    .from(experiences)
    .where(and(eq(experiences.userId, userId), isNull(experiences.deletedAt)))
    .orderBy(desc(experiences.resolvedAt));
  return rows.filter((r) => r.status !== "planned");
}

export async function getExperience(
  userId: number,
  id: number,
): Promise<ExperienceRow | null> {
  return getOwned(userId, id);
}

export async function xpSummary(userId: number): Promise<ExperienceXpSummary> {
  const rows = await db
    .select({ adventureXp: experiences.adventureXp, status: experiences.status })
    .from(experiences)
    .where(and(eq(experiences.userId, userId), isNull(experiences.deletedAt)));
  return {
    total: rows.reduce((s, r) => s + r.adventureXp, 0),
    completedCount: rows.filter((r) => r.status === "completed").length,
  };
}

/* Plan fields the owner may set/edit while an experience is `planned`. */
export interface PlanInput {
  title: string;
  description?: string | null;
  plannedDate?: string | null;
  plannedTimeText?: string | null;
  locationText?: string | null;
  expectedCost?: number | null;
  expectedDurationMinutes?: number | null;
  physicalDifficulty?: PhysicalDifficulty | null;
  desiredFeeling?: string | null;
  notes?: string | null;
}

/** Maps plan fields EXCEPT title (title is required on insert and handled by
 * the caller). */
function planColumns(input: Partial<PlanInput>): Partial<NewExperience> {
  const c: Partial<NewExperience> = {};
  if ("description" in input) c.description = input.description ?? null;
  if ("plannedDate" in input) c.plannedDate = input.plannedDate ?? null;
  if ("plannedTimeText" in input) c.plannedTimeText = input.plannedTimeText ?? null;
  if ("locationText" in input) c.locationText = input.locationText ?? null;
  if ("expectedCost" in input) c.expectedCost = money(input.expectedCost);
  if ("expectedDurationMinutes" in input)
    c.expectedDurationMinutes = input.expectedDurationMinutes ?? null;
  if ("physicalDifficulty" in input) c.physicalDifficulty = input.physicalDifficulty ?? null;
  if ("desiredFeeling" in input) c.desiredFeeling = input.desiredFeeling ?? null;
  if ("notes" in input) c.notes = input.notes ?? null;
  return c;
}

/** Create one planned experience from an owned request. Duplicate-safe:
 * a request already `planned` is rejected, and a DB partial-unique index on
 * request_id (where not deleted) backstops any race. The request is advanced
 * to `planned` only after the experience write succeeds. */
export async function createPlannedExperience(
  userId: number,
  requestId: number,
  input: PlanInput,
): Promise<ExperienceRow> {
  const [request] = await db
    .select()
    .from(experienceRequests)
    .where(
      and(
        eq(experienceRequests.id, requestId),
        eq(experienceRequests.userId, userId),
        isNull(experienceRequests.deletedAt),
      ),
    )
    .limit(1);
  if (!request) throw new ExperienceError(404, "Experience request not found.");
  if (request.status === "planned") {
    throw new ExperienceError(409, "A plan already exists for this request.");
  }

  let row: ExperienceRow;
  try {
    [row] = await db
      .insert(experiences)
      .values({ userId, requestId, status: "planned", title: input.title, ...planColumns(input) })
      .returning();
  } catch (err) {
    // Unique-index violation => a concurrent plan already exists.
    if (String(err).includes("experiences_request_live_uq")) {
      throw new ExperienceError(409, "A plan already exists for this request.");
    }
    throw err;
  }

  // Advance the request only after the experience write succeeded.
  await db
    .update(experienceRequests)
    .set({ status: "planned", updatedAt: new Date() })
    .where(and(eq(experienceRequests.id, requestId), eq(experienceRequests.userId, userId)));

  return row;
}

/** Edit plan fields — only while the experience is still `planned`. */
export async function updatePlannedExperience(
  userId: number,
  id: number,
  input: Partial<PlanInput>,
): Promise<ExperienceRow> {
  const current = await getOwned(userId, id);
  if (!current) throw new ExperienceError(404, "Experience not found.");
  if (current.status !== "planned") {
    throw new ExperienceError(409, "Only a planned experience can be edited.");
  }
  const cols = planColumns(input);
  if (input.title !== undefined) cols.title = input.title;
  if (Object.keys(cols).length === 0) {
    throw new ExperienceError(400, "Nothing to update.");
  }
  const [row] = await db
    .update(experiences)
    .set({ ...cols, updatedAt: new Date() })
    .where(and(eq(experiences.id, id), eq(experiences.userId, userId)))
    .returning();
  return row;
}

export interface OutcomeInput {
  actualCost?: number | null;
  rating?: number | null;
  reflection?: string | null;
  nonCompletionReason?: string | null;
  meaningfulExperience?: boolean;
}

function outcomeColumns(input: OutcomeInput): Partial<NewExperience> {
  const c: Partial<NewExperience> = {};
  if ("actualCost" in input) c.actualCost = money(input.actualCost);
  if ("rating" in input) c.rating = input.rating ?? null;
  if ("reflection" in input) c.reflection = input.reflection ?? null;
  if ("nonCompletionReason" in input)
    c.nonCompletionReason = input.nonCompletionReason ?? null;
  return c;
}

/** One-way resolution: `planned` -> completed/cancelled/not_completed. XP is
 * computed server-side and stored. Cannot be called on an already-resolved row. */
export async function resolveExperience(
  userId: number,
  id: number,
  status: ResolvedStatus,
  input: OutcomeInput,
): Promise<ExperienceRow> {
  const current = await getOwned(userId, id);
  if (!current) throw new ExperienceError(404, "Experience not found.");
  if (current.status !== "planned") {
    throw new ExperienceError(409, "This experience has already been resolved.");
  }
  const meaningful = input.meaningfulExperience ?? false;
  const now = new Date();
  const [row] = await db
    .update(experiences)
    .set({
      ...outcomeColumns(input),
      status,
      meaningfulExperience: meaningful,
      adventureXp: computeXp(status, meaningful),
      resolvedAt: now,
      completedAt: status === "completed" ? now : null,
      updatedAt: now,
    })
    .where(and(eq(experiences.id, id), eq(experiences.userId, userId)))
    .returning();
  return row;
}

/** Correct outcome details AFTER resolution. Status is never changed. When the
 * meaningful flag changes on a completed experience, XP is recalculated. */
export async function correctOutcomeDetails(
  userId: number,
  id: number,
  input: OutcomeInput,
): Promise<ExperienceRow> {
  const current = await getOwned(userId, id);
  if (!current) throw new ExperienceError(404, "Experience not found.");
  if (current.status === "planned") {
    throw new ExperienceError(409, "This experience has not been resolved yet.");
  }
  const patch: Partial<NewExperience> = outcomeColumns(input);
  if ("meaningfulExperience" in input && input.meaningfulExperience !== undefined) {
    patch.meaningfulExperience = input.meaningfulExperience;
    // Recompute XP from the (unchanged) resolved status + new meaningful flag.
    patch.adventureXp = computeXp(current.status, input.meaningfulExperience);
  }
  if (Object.keys(patch).length === 0) {
    throw new ExperienceError(400, "Nothing to update.");
  }
  const [row] = await db
    .update(experiences)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(experiences.id, id), eq(experiences.userId, userId)))
    .returning();
  return row;
}

/** Soft delete — never a hard delete.
 *
 * Lifecycle integrity: soft-deleting a still-`planned` experience would otherwise
 * strand its request in `planned` with no live experience (invisible in the
 * drafts list and non-re-plannable). We recover the request to `draft` so it is
 * usable again; its constraint data is preserved. Build 1 has no
 * `interpreted` / `recommendations_ready` states or stored recommendations yet,
 * so `draft` is the only consistent recovery target — the owner's richer
 * two-state recovery becomes implementable once those states/columns exist in a
 * later build. A RESOLVED experience that is deleted leaves the request
 * `planned` unchanged: removing a history record must not re-activate the
 * request as an active draft. */
export async function deleteExperience(userId: number, id: number) {
  const current = await getOwned(userId, id);
  if (!current) throw new ExperienceError(404, "Experience not found.");
  const now = new Date();
  const [row] = await db
    .update(experiences)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(experiences.id, id), eq(experiences.userId, userId)))
    .returning();

  if (current.status === "planned") {
    await db
      .update(experienceRequests)
      .set({ status: "draft", updatedAt: now })
      .where(
        and(
          eq(experienceRequests.id, current.requestId),
          eq(experienceRequests.userId, userId),
          isNull(experienceRequests.deletedAt),
        ),
      );
  }
  return row;
}
