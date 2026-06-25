/* Home / Today (Home 1A) data assembly.
 *
 * Deterministic, real-data-only. Reuses existing services + the deterministic
 * ranker in lib/briefing.ts. NO AI, no new mutation logic, no new schema.
 *
 * Resilience model:
 *  - A CORE read (the owner identity) doubles as a DB-liveness probe. If it
 *    throws, buildHomeView throws and the page shows a single full-page error.
 *  - Each SECTION is loaded independently (Promise.allSettled); a single
 *    section failure degrades only that section (ok:false), never the page.
 *  - No mock fallback anywhere.
 */

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { listTasks, toTaskViews } from "@/lib/services/tasks";
import { localToday } from "@/lib/time";
import { listObligations, toObligationViews } from "@/lib/services/obligations";
import {
  computeFinancialOutlook,
  listAccounts,
  toAccountViews,
  computeCashSummary,
  listBills,
  toBillViews,
  listIncome,
  toIncomeViews,
  listAllocations,
  allocationsByIncome,
} from "@/lib/services/finances";
import { listTransfers, toTransferViews } from "@/lib/services/transfers";
import { computeProjection } from "@/lib/services/finance-projection";
import {
  listPlanned,
  listHistory,
  xpSummary,
  toExperienceViews,
} from "@/lib/services/experiences";
import { rankNeedsAttention } from "@/lib/briefing";
import type {
  HomeView,
  HomeSection,
  HomeNeedItem,
  HomeComingItem,
  HomeMoney,
  HomeMomentum,
} from "@/lib/types";

const OBLIGATION_CLOSED = new Set(["done", "cancelled", "missed"]);

// Generic placeholder names are treated as "no name" (trimmed, case-insensitive).
const PLACEHOLDER_NAMES = new Set(["", "owner", "user"]);

/** Pure: derive a usable first name from a stored `users.name`, or null when the
 * value is missing or a generic placeholder. */
export function firstNameFromStored(name: string | null | undefined): string | null {
  const trimmed = (name ?? "").trim();
  if (!trimmed || PLACEHOLDER_NAMES.has(trimmed.toLowerCase())) return null;
  return trimmed.split(/\s+/)[0];
}

/** First name from the owner's stored `users.name` (no new field/migration). */
export async function getOwnerFirstName(userId: number): Promise<string | null> {
  const [row] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return firstNameFromStored(row?.name);
}

function settle<T>(r: PromiseSettledResult<T>): HomeSection<T> {
  if (r.status === "fulfilled") return { ok: true, data: r.value };
  console.error("Home section failed:", r.reason);
  return { ok: false, data: null };
}

async function loadNeedsAttention(userId: number): Promise<{
  items: HomeNeedItem[];
  openTaskCount: number;
  openObligationCount: number;
}> {
  const [tasks, obligations] = await Promise.all([
    listTasks(userId).then(toTaskViews),
    listObligations(userId).then(toObligationViews),
  ]);
  // The overdue-bill indicator is best-effort: a finance failure must not fail this section.
  let finances = null;
  try {
    finances = await computeFinancialOutlook(userId);
  } catch (err) {
    console.error("Home needs-attention: finance probe failed (omitting bill item).", err);
  }
  const items = rankNeedsAttention({ tasks, obligations, finances });
  const openTaskCount = tasks.filter(
    (t) => t.status !== "completed" && t.status !== "cancelled",
  ).length;
  const openObligationCount = obligations.filter((o) => !OBLIGATION_CLOSED.has(o.status)).length;
  return { items, openTaskCount, openObligationCount };
}

async function loadComingUp(userId: number): Promise<HomeComingItem[]> {
  const obligations = toObligationViews(await listObligations(userId))
    .filter((o) => !OBLIGATION_CLOSED.has(o.status))
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
    .slice(0, 3)
    .map<HomeComingItem>((o) => ({
      key: `obl-${o.id}`,
      kind: "obligation",
      title: o.title,
      date: o.startDate,
      detail: o.location ?? o.type,
    }));

  // Next planned experience is best-effort.
  let experienceItem: HomeComingItem | null = null;
  try {
    const planned = toExperienceViews(await listPlanned(userId));
    const next = [...planned]
      .filter((e) => e.plannedDate)
      .sort((a, b) => (a.plannedDate ?? "").localeCompare(b.plannedDate ?? ""))[0]
      ?? planned[0];
    if (next) {
      experienceItem = {
        key: `exp-${next.id}`,
        kind: "experience",
        title: next.title,
        date: next.plannedDate,
        detail: "Planned experience",
      };
    }
  } catch (err) {
    console.error("Home coming-up: planned-experience probe failed.", err);
  }

  const merged = experienceItem ? [...obligations, experienceItem] : obligations;
  return merged
    .sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999"))
    .slice(0, 4);
}

async function loadMoney(userId: number): Promise<HomeMoney> {
  const [outlook, accounts, bills, incomeRows, allocRows, transfers] = await Promise.all([
    computeFinancialOutlook(userId),
    listAccounts(userId).then(toAccountViews),
    listBills(userId).then(toBillViews),
    listIncome(userId),
    listAllocations(userId),
    listTransfers(userId).then(toTransferViews),
  ]);
  const income = toIncomeViews(incomeRows, allocationsByIncome(allocRows));
  const cash = computeCashSummary(accounts);
  // Default Home horizon: "until next payday" (falls back to 14 days when none).
  const projection = computeProjection({
    accounts, bills, income, transfers, horizon: "payday", today: localToday(),
  });
  const dueBills = bills
    .filter((b) => b.status !== "paid")
    .sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"))
    .slice(0, 3);
  return {
    estimatedRemaining: outlook.estimatedRemaining,
    accountsTotal: outlook.accountsTotal,
    billsDueBeforePayday: outlook.billsDueBeforePayday,
    overdueCount: outlook.overdueCount,
    due7: outlook.due7,
    due30: outlook.due30,
    nextPaydayDate: outlook.nextPaydayDate,
    dueBills,
    manualActualCash: cash.totalActualCash,
    projectedCash: projection.totals.totalProjectedCash,
    projectionHorizonLabel: projection.horizonLabel,
    hasShortfall: projection.warnings.some((w) => w.code === "shortfall"),
  };
}

async function loadMomentum(userId: number): Promise<HomeMomentum> {
  const [xp, planned, history, taskRows] = await Promise.all([
    xpSummary(userId),
    listPlanned(userId).then(toExperienceViews),
    listHistory(userId).then(toExperienceViews),
    listTasks(userId).then(toTaskViews),
  ]);
  const today = localToday();
  const tasksCompletedToday = taskRows.filter(
    (t) => t.status === "completed" && t.completedAt && localToday(new Date(t.completedAt)) === today,
  ).length;
  const nextPlanned =
    [...planned]
      .filter((e) => e.plannedDate)
      .sort((a, b) => (a.plannedDate ?? "").localeCompare(b.plannedDate ?? ""))[0] ??
    planned[0] ??
    null;
  const lastResolved = history[0] ?? null; // listHistory is ordered by resolvedAt desc
  return {
    totalXp: xp.total,
    completedCount: xp.completedCount,
    plannedCount: planned.length,
    tasksCompletedToday,
    nextPlanned: nextPlanned
      ? { id: nextPlanned.id, title: nextPlanned.title, plannedDate: nextPlanned.plannedDate }
      : null,
    lastResolved: lastResolved
      ? { id: lastResolved.id, title: lastResolved.title, status: lastResolved.status }
      : null,
  };
}

/** Assemble the Home view. Throws only on core/DB failure (full-page error). */
export async function buildHomeView(userId: number): Promise<HomeView> {
  // CORE — also the DB-liveness probe. A throw here surfaces the full-page error.
  const firstName = await getOwnerFirstName(userId);

  const [na, cu, mo, mm] = await Promise.allSettled([
    loadNeedsAttention(userId),
    loadComingUp(userId),
    loadMoney(userId),
    loadMomentum(userId),
  ]);

  return {
    firstName,
    needsAttention: settle(na),
    comingUp: settle(cu),
    money: settle(mo),
    momentum: settle(mm),
  };
}
