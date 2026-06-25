/* Income schedules service — Finance 1A.4.
 *
 * A recurring income SCHEDULE is the reusable rule; its OCCURRENCES are
 * materialized as `income_entries` rows (linked by `scheduleId`) so they reuse
 * the existing receipt/reversal/split/projection machinery. Generation is
 * bounded (a rolling −14…+90 day window), idempotent (a partial unique index +
 * an existing-date check), and never resurrects deleted/received occurrences.
 *
 * First-version edit rule: editing a schedule (fields or split, pause, delete)
 * regenerates only its FUTURE `scheduled` occurrences — received/skipped/
 * cancelled/past occurrences are preserved untouched. */

import { and, asc, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  incomeSchedules,
  incomeScheduleAllocations,
  incomeEntries,
  incomeAllocations,
  financialAccounts,
} from "@/db/schema";
import {
  FinanceError,
  requireCashAccount,
  ESTIMATE_TYPES,
  INCOME_CADENCES,
} from "@/lib/services/finances";
import { validateAllocationSet, type AllocationInput } from "@/lib/finance-allocations";
import {
  generateOccurrenceDates,
  nextOccurrenceDate,
  addDays,
  type RecurrenceRule,
} from "@/lib/finance-recurrence";
import type { IncomeScheduleView, AllocationView } from "@/lib/types";

export type NewSchedule = typeof incomeSchedules.$inferInsert;
export type ScheduleRow = typeof incomeSchedules.$inferSelect;

// Rolling materialization window (days, relative to "today").
export const WINDOW_BACK = 14;
export const WINDOW_FORWARD = 90;

const num = (v: string | null | undefined): number => (v ? parseFloat(v) : 0);

function ruleOf(s: ScheduleRow): RecurrenceRule {
  return {
    cadence: s.cadence,
    anchorDate: s.anchorDate,
    endDate: s.endDate,
    dayOfMonth: s.dayOfMonth,
    dayA: s.dayA,
    dayB: s.dayB,
  };
}

/* ------------------------------------------------------------- queries --- */

export async function listSchedules(userId: number) {
  return db
    .select()
    .from(incomeSchedules)
    .where(and(eq(incomeSchedules.userId, userId), isNull(incomeSchedules.deletedAt)))
    .orderBy(asc(incomeSchedules.source));
}

export async function getSchedule(userId: number, id: number) {
  const [row] = await db
    .select()
    .from(incomeSchedules)
    .where(and(eq(incomeSchedules.id, id), eq(incomeSchedules.userId, userId), isNull(incomeSchedules.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function listScheduleAllocations(userId: number) {
  return db
    .select({
      id: incomeScheduleAllocations.id,
      scheduleId: incomeScheduleAllocations.scheduleId,
      accountId: incomeScheduleAllocations.accountId,
      accountName: financialAccounts.name,
      allocationType: incomeScheduleAllocations.allocationType,
      value: incomeScheduleAllocations.value,
      position: incomeScheduleAllocations.position,
    })
    .from(incomeScheduleAllocations)
    .leftJoin(financialAccounts, eq(incomeScheduleAllocations.accountId, financialAccounts.id))
    .where(eq(incomeScheduleAllocations.userId, userId))
    .orderBy(asc(incomeScheduleAllocations.scheduleId), asc(incomeScheduleAllocations.position));
}

export function toScheduleViews(
  rows: ScheduleRow[],
  allocationsBySchedule: Map<number, AllocationView[]>,
  today: string,
): IncomeScheduleView[] {
  return rows.map((s) => ({
    id: s.id,
    source: s.source,
    cadence: s.cadence,
    anchorDate: s.anchorDate,
    expectedAmount: num(s.expectedAmount),
    estimateType: s.estimateType,
    expectedMin: s.expectedMin != null ? num(s.expectedMin) : null,
    expectedMax: s.expectedMax != null ? num(s.expectedMax) : null,
    destinationAccountId: s.destinationAccountId ?? null,
    dayOfMonth: s.dayOfMonth ?? null,
    dayA: s.dayA ?? null,
    dayB: s.dayB ?? null,
    isPayday: s.isPayday,
    active: s.active,
    endDate: s.endDate,
    nextDate: s.active ? nextOccurrenceDate(ruleOf(s), today) : null,
    allocations: allocationsBySchedule.get(s.id) ?? [],
  }));
}

export function scheduleAllocationsBySchedule(
  rows: Awaited<ReturnType<typeof listScheduleAllocations>>,
): Map<number, AllocationView[]> {
  const m = new Map<number, AllocationView[]>();
  for (const r of rows) {
    const v: AllocationView = {
      id: r.id,
      accountId: r.accountId,
      accountName: r.accountName ?? null,
      allocationType: r.allocationType,
      value: r.value != null ? num(r.value) : null,
      position: r.position,
    };
    if (!m.has(r.scheduleId)) m.set(r.scheduleId, []);
    m.get(r.scheduleId)!.push(v);
  }
  return m;
}

/* ------------------------------------------------------------- writes --- */

export interface ScheduleInput {
  source: string;
  cadence: string;
  anchorDate: string;
  expectedAmount?: number;
  estimateType?: string;
  expectedMin?: number | null;
  expectedMax?: number | null;
  destinationAccountId?: number | null;
  dayOfMonth?: number | null;
  dayA?: number | null;
  dayB?: number | null;
  isPayday?: boolean;
  active?: boolean;
  endDate?: string | null;
}

function validateScheduleInput(input: Partial<ScheduleInput>) {
  if (input.cadence !== undefined && !(INCOME_CADENCES as readonly string[]).includes(input.cadence))
    throw new FinanceError(400, "Invalid cadence.");
  if (input.estimateType !== undefined && !(ESTIMATE_TYPES as readonly string[]).includes(input.estimateType))
    throw new FinanceError(400, "Invalid estimate type.");
  const dayOk = (d: number | null | undefined) => d == null || (Number.isInteger(d) && d >= 1 && d <= 31);
  if (!dayOk(input.dayOfMonth) || !dayOk(input.dayA) || !dayOk(input.dayB))
    throw new FinanceError(400, "Day of month must be 1–31 (a day past month-end resolves to the last day).");
  if (input.estimateType === "range") {
    const lo = input.expectedMin, hi = input.expectedMax;
    if (lo == null || hi == null || !(lo >= 0) || !(hi >= lo))
      throw new FinanceError(400, "A range estimate needs a minimum and a maximum (max ≥ min ≥ 0).");
  }
}

export async function createSchedule(userId: number, input: ScheduleInput, today: string) {
  if (!input.source?.trim()) throw new FinanceError(400, "A source is required.");
  validateScheduleInput(input);
  if (input.destinationAccountId != null) await requireCashAccount(userId, input.destinationAccountId);

  const [row] = await db
    .insert(incomeSchedules)
    .values({
      userId,
      source: input.source.trim(),
      cadence: input.cadence as ScheduleRow["cadence"],
      anchorDate: input.anchorDate,
      expectedAmount: (input.estimateType === "unknown" ? 0 : input.expectedAmount ?? 0).toFixed(2),
      estimateType: (input.estimateType ?? "fixed") as ScheduleRow["estimateType"],
      expectedMin: input.expectedMin != null ? input.expectedMin.toFixed(2) : null,
      expectedMax: input.expectedMax != null ? input.expectedMax.toFixed(2) : null,
      destinationAccountId: input.destinationAccountId ?? null,
      dayOfMonth: input.dayOfMonth ?? null,
      dayA: input.dayA ?? null,
      dayB: input.dayB ?? null,
      isPayday: input.isPayday ?? true,
      active: input.active ?? true,
      endDate: input.endDate ?? null,
    })
    .returning();
  await generateOccurrences(userId, row, today);
  return row;
}

export async function updateSchedule(userId: number, id: number, input: Partial<ScheduleInput>, today: string) {
  const existing = await getSchedule(userId, id);
  if (!existing) throw new FinanceError(404, "Schedule not found.");
  validateScheduleInput(input);
  if (input.destinationAccountId != null) await requireCashAccount(userId, input.destinationAccountId);

  const patch: Partial<NewSchedule> = { updatedAt: new Date() };
  if (input.source !== undefined) patch.source = input.source.trim();
  if (input.cadence !== undefined) patch.cadence = input.cadence as ScheduleRow["cadence"];
  if (input.anchorDate !== undefined) patch.anchorDate = input.anchorDate;
  if (input.estimateType !== undefined) patch.estimateType = input.estimateType as ScheduleRow["estimateType"];
  if (input.expectedAmount !== undefined) patch.expectedAmount = input.expectedAmount.toFixed(2);
  if (input.estimateType === "unknown") patch.expectedAmount = "0.00";
  if (input.expectedMin !== undefined) patch.expectedMin = input.expectedMin != null ? input.expectedMin.toFixed(2) : null;
  if (input.expectedMax !== undefined) patch.expectedMax = input.expectedMax != null ? input.expectedMax.toFixed(2) : null;
  if (input.destinationAccountId !== undefined) patch.destinationAccountId = input.destinationAccountId;
  if (input.dayOfMonth !== undefined) patch.dayOfMonth = input.dayOfMonth;
  if (input.dayA !== undefined) patch.dayA = input.dayA;
  if (input.dayB !== undefined) patch.dayB = input.dayB;
  if (input.isPayday !== undefined) patch.isPayday = input.isPayday;
  if (input.active !== undefined) patch.active = input.active;
  if (input.endDate !== undefined) patch.endDate = input.endDate;

  const [row] = await db
    .update(incomeSchedules)
    .set(patch)
    .where(and(eq(incomeSchedules.id, id), eq(incomeSchedules.userId, userId), isNull(incomeSchedules.deletedAt)))
    .returning();
  if (!row) throw new FinanceError(404, "Schedule not found.");
  await regenerateFutureOccurrences(userId, row, today);
  return row;
}

export async function setScheduleAllocations(
  userId: number,
  scheduleId: number,
  allocations: AllocationInput[],
  today: string,
) {
  const schedule = await getSchedule(userId, scheduleId);
  if (!schedule) throw new FinanceError(404, "Schedule not found.");
  const structural = validateAllocationSet(allocations);
  if (structural) throw new FinanceError(400, structural);
  for (const a of allocations) await requireCashAccount(userId, a.accountId);

  await db.delete(incomeScheduleAllocations).where(eq(incomeScheduleAllocations.scheduleId, scheduleId));
  await db.insert(incomeScheduleAllocations).values(
    allocations.map((a, i) => ({
      userId,
      scheduleId,
      accountId: a.accountId,
      allocationType: a.allocationType,
      value: a.allocationType === "remainder" || a.value == null ? null : String(a.value),
      position: i,
    })),
  );
  // Split mode: clear single destination, then regenerate future occurrences.
  const [row] = await db
    .update(incomeSchedules)
    .set({ destinationAccountId: null, updatedAt: new Date() })
    .where(and(eq(incomeSchedules.id, scheduleId), eq(incomeSchedules.userId, userId)))
    .returning();
  await regenerateFutureOccurrences(userId, row, today);
  return row;
}

/**
 * Remove a schedule WITHOUT corrupting financial history.
 *  - If it has ANY occurrence (generated/received/skipped/cancelled/etc.) it is
 *    ARCHIVED (soft-deleted + paused): all occurrences and ledger movements are
 *    left intact and readable, and no new occurrences are generated.
 *  - Only a genuinely unused schedule (no occurrences) is hard-deleted.
 * Returns `{ row, mode }` (mode = "archived" | "deleted"), or null if not found.
 * The FK `income_entries.schedule_id ON DELETE no action` is the DB-level
 * backstop: a hard delete of a schedule with occurrences would be rejected.
 */
export async function deleteSchedule(userId: number, id: number, _today: string) {
  const schedule = await getSchedule(userId, id);
  if (!schedule) return null;

  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(incomeEntries)
    .where(and(eq(incomeEntries.scheduleId, id), eq(incomeEntries.userId, userId)));
  const hasHistory = Number(n) > 0;

  if (hasHistory) {
    // Archive: keep every occurrence + movement; stop future generation.
    const [row] = await db
      .update(incomeSchedules)
      .set({ deletedAt: new Date(), active: false, updatedAt: new Date() })
      .where(and(eq(incomeSchedules.id, id), eq(incomeSchedules.userId, userId)))
      .returning();
    return row ? { row, mode: "archived" as const } : null;
  }

  // Genuinely unused → hard delete (cascade only removes the schedule's own
  // allocation snapshot; there are no occurrences/movements to touch).
  await db.delete(incomeScheduleAllocations).where(eq(incomeScheduleAllocations.scheduleId, id));
  const [row] = await db
    .delete(incomeSchedules)
    .where(and(eq(incomeSchedules.id, id), eq(incomeSchedules.userId, userId)))
    .returning();
  return row ? { row, mode: "deleted" as const } : null;
}

/* ----------------------------------------------------- generation ------- */

/** Materialize missing occurrences for `schedule` within the rolling window.
 * Idempotent: skips dates that already have a (non-deleted) occurrence, and uses
 * ON CONFLICT DO NOTHING as a concurrency backstop. Inactive → no occurrences. */
export async function generateOccurrences(userId: number, schedule: ScheduleRow, today: string) {
  if (!schedule.active || schedule.deletedAt) return [];
  const dates = generateOccurrenceDates(ruleOf(schedule), addDays(today, -WINDOW_BACK), addDays(today, WINDOW_FORWARD));
  if (!dates.length) return [];

  // Claim rule dates by `scheduledFor` (or payDate for legacy rows): a date that
  // any live occurrence already fills — including a received/skipped/cancelled
  // one, or an OVERRIDDEN occurrence whose payDate was moved — is never
  // regenerated, so there is no duplicate on the original or the overridden date.
  const existing = new Set(
    (
      await db
        .select({ scheduledFor: incomeEntries.scheduledFor, payDate: incomeEntries.payDate })
        .from(incomeEntries)
        .where(and(eq(incomeEntries.scheduleId, schedule.id), eq(incomeEntries.userId, userId), isNull(incomeEntries.deletedAt)))
    ).map((r) => r.scheduledFor ?? r.payDate),
  );
  const missing = dates.filter((d) => !existing.has(d));
  if (!missing.length) return [];

  const schedAllocs = await db
    .select()
    .from(incomeScheduleAllocations)
    .where(eq(incomeScheduleAllocations.scheduleId, schedule.id));

  const inserted: { id: number; payDate: string }[] = [];
  for (const date of missing) {
    const [row] = await db
      .insert(incomeEntries)
      .values({
        userId,
        source: schedule.source,
        expectedAmount: schedule.expectedAmount,
        payDate: date,
        recurrence: "one_time", // the occurrence itself is a single instance
        isPayday: schedule.isPayday,
        destinationAccountId: schedule.destinationAccountId,
        status: "scheduled",
        scheduleId: schedule.id,
        scheduledFor: date, // the rule date this occurrence fills
        estimateType: schedule.estimateType,
        expectedMin: schedule.expectedMin,
        expectedMax: schedule.expectedMax,
      })
      .onConflictDoNothing()
      .returning({ id: incomeEntries.id, payDate: incomeEntries.payDate });
    if (row) {
      inserted.push(row);
      if (schedAllocs.length) {
        await db.insert(incomeAllocations).values(
          schedAllocs.map((a) => ({
            userId,
            incomeId: row.id,
            accountId: a.accountId,
            allocationType: a.allocationType,
            value: a.value,
            position: a.position,
          })),
        );
      }
    }
  }
  return inserted;
}

/** Generate occurrences for every active schedule (call on /finances + Home load). */
export async function replenishOccurrences(userId: number, today: string) {
  const schedules = await listSchedules(userId);
  for (const s of schedules) await generateOccurrences(userId, s, today);
}

async function deleteFutureScheduledOccurrences(userId: number, scheduleId: number, today: string) {
  // Only FUTURE, still-scheduled, NON-OVERRIDDEN occurrences are regenerable.
  // Overridden / received / skipped / cancelled / past occurrences are preserved.
  const future = await db
    .select({ id: incomeEntries.id })
    .from(incomeEntries)
    .where(
      and(
        eq(incomeEntries.scheduleId, scheduleId),
        eq(incomeEntries.userId, userId),
        eq(incomeEntries.status, "scheduled"),
        eq(incomeEntries.isOverridden, false),
        gte(incomeEntries.payDate, today),
        isNull(incomeEntries.deletedAt),
      ),
    );
  for (const o of future) {
    await db.delete(incomeAllocations).where(eq(incomeAllocations.incomeId, o.id));
    await db.delete(incomeEntries).where(eq(incomeEntries.id, o.id));
  }
}

/** First-version schedule-edit rule: drop FUTURE scheduled occurrences and
 * regenerate from the (possibly changed/paused) schedule. Preserves received/
 * skipped/cancelled/past occurrences. */
async function regenerateFutureOccurrences(userId: number, schedule: ScheduleRow, today: string) {
  await deleteFutureScheduledOccurrences(userId, schedule.id, today);
  await generateOccurrences(userId, schedule, today);
}
