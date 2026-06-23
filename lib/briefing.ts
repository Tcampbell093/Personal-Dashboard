/* =============================================================================
 * Rule-based intelligence engine — Phase 1.
 *
 * NO AI, NO external calls, NO cost. Pure deterministic rules over the data
 * already in the system. This same module is reused by the scheduled Netlify
 * function so the daily briefing logic lives in exactly one place.
 *
 * When AI is enabled later, this becomes the deterministic fallback that runs
 * whenever the kill switch is on or a budget limit is hit.
 * ========================================================================== */

import type {
  Briefing,
  TaskView,
  ObligationView,
  OpportunityView,
  FinancialOutlook,
  HomeNeedItem,
  Tier,
} from "./types";
import { localToday, localDaysUntil } from "./time";

const PRIORITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const todayIso = () => localToday();

/** Pick the single most pressing task: highest priority, then earliest due. */
export function topTask(tasks: TaskView[]): TaskView | null {
  const open = tasks.filter(
    (t) => t.status !== "completed" && t.status !== "cancelled",
  );
  if (open.length === 0) return null;
  return [...open].sort((a, b) => {
    const p = (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0);
    if (p !== 0) return p;
    return (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999");
  })[0];
}

const OBLIGATION_CLOSED = new Set(["done", "cancelled", "missed"]);

/** Nearest still-open obligation by start date. */
export function topObligation(obligations: ObligationView[]): ObligationView | null {
  const upcoming = obligations
    .filter((o) => !OBLIGATION_CLOSED.has(o.status))
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  return upcoming[0] ?? null;
}

/** Most relevant opportunity: relevance via confidence, then soonest deadline. */
export function topOpportunity(opps: OpportunityView[]): OpportunityView | null {
  const live = opps.filter((o) => o.status !== "dismissed" && o.status !== "expired");
  if (live.length === 0) return null;
  return [...live].sort((a, b) => {
    const c = (b.confidenceScore ?? 0) - (a.confidenceScore ?? 0);
    if (c !== 0) return c;
    return (a.timeWindowEnd ?? "9999").localeCompare(b.timeWindowEnd ?? "9999");
  })[0];
}

/** Build a deterministic warning from the data, or null if nothing's wrong. */
export function buildWarning(
  finances: FinancialOutlook,
  tasks: TaskView[],
): string | null {
  const today = todayIso();
  const overdueTasks = tasks.filter(
    (t) =>
      t.dueDate &&
      t.dueDate < today &&
      t.status !== "completed" &&
      t.status !== "cancelled",
  ).length;

  const parts: string[] = [];
  if (finances.overdueCount > 0) {
    parts.push(
      `${finances.overdueCount} overdue ${finances.overdueCount === 1 ? "bill" : "bills"}`,
    );
  }
  if (overdueTasks > 0) {
    parts.push(`${overdueTasks} overdue ${overdueTasks === 1 ? "task" : "tasks"}`);
  }
  if (finances.estimatedRemaining < finances.billsDueBeforePayday) {
    parts.push("bills before payday may exceed available balance");
  }
  return parts.length ? `Needs attention: ${parts.join("; ")}.` : null;
}

/** Generate the full rule-based daily briefing. */
export function generateBriefing(input: {
  tasks: TaskView[];
  obligations: ObligationView[];
  opportunities: OpportunityView[];
  finances: FinancialOutlook;
}): Briefing {
  const task = topTask(input.tasks);
  const obligation = topObligation(input.obligations);
  const opp = topOpportunity(input.opportunities);
  const warning = buildWarning(input.finances, input.tasks);

  const openTaskCount = input.tasks.filter(
    (t) => t.status !== "completed" && t.status !== "cancelled",
  ).length;
  const openObligationCount = input.obligations.filter(
    (o) => !OBLIGATION_CLOSED.has(o.status),
  ).length;

  const summary =
    `${openTaskCount} open ${openTaskCount === 1 ? "task" : "tasks"}, ` +
    `${openObligationCount} upcoming ${openObligationCount === 1 ? "obligation" : "obligations"}` +
    (opp ? `, 1 live opportunity worth a look.` : `.`);

  return {
    date: todayIso(),
    summary,
    mostImportantTask: task ? task.title : "No open tasks.",
    mostImportantObligation: obligation
      ? `${obligation.title} (${obligation.startDate})`
      : "Nothing on the calendar.",
    mostRelevantOpportunity: opp ? opp.title : "No active opportunities.",
    warning,
  };
}

/* ---------------------------------------------------------------- triage --- */
/* Map any dated item to a tier. This is the signature of the whole product:
 * the dashboard is a triage, not a feed. */

// Whole-day difference vs. the local (app-timezone) calendar date.
const DAYS = (dateStr: string | null): number => localDaysUntil(dateStr);

/** Tier for a task: due today/overdue or critical = act; soon = aware. */
export function tierForTask(t: TaskView): Tier {
  const d = DAYS(t.dueDate);
  if (t.priority === "critical" || d <= 0) return "act_today";
  if (t.priority === "high" || d <= 3) return "be_aware";
  return "explore";
}

/** Tier for an opportunity: closing today = act; this week = aware. */
export function tierForOpportunity(o: OpportunityView): Tier {
  const d = DAYS(o.timeWindowEnd);
  if (d <= 0) return "act_today";
  if (d <= 7) return "be_aware";
  return "explore";
}

/* ----------------------------------------------- Home: needs attention --- */
/* Deterministic, explainable ranking for the Home / Today "Needs attention"
 * list. Every item carries a visible `reason`; higher `rank` = more urgent. At
 * most ONE reason per task/obligation (the most urgent that applies). The Home
 * page slices the sorted result to a small curated number (≈5). No AI. */

const ATTENTION_HORIZON_DAYS = 3;
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** The single most urgent reason for a dated, open item, or null if not pressing. */
function datedReason(dateStr: string | null): { reason: string; tone: "act" | "aware"; rank: number } | null {
  const d = DAYS(dateStr);
  if (d === Infinity) return null;
  if (d < 0) return { reason: `Overdue ${plural(-d, "day")}`, tone: "act", rank: 1000 + Math.min(-d, 999) };
  if (d === 0) return { reason: "Due today", tone: "act", rank: 900 };
  if (d <= ATTENTION_HORIZON_DAYS) return { reason: `Due in ${plural(d, "day")}`, tone: "aware", rank: 700 - d };
  return null;
}

/**
 * Build the ranked Needs-attention list from real data. Tasks get the most
 * urgent of: overdue / due-today / due-soon (by date), else critical / high
 * priority. Obligations: overdue / due-today / due-soon by start date. Bills:
 * a single item when there are overdue bills. Returns ALL qualifying items,
 * sorted most-urgent first; the caller curates the top N.
 */
export function rankNeedsAttention(input: {
  tasks: TaskView[];
  obligations: ObligationView[];
  finances?: FinancialOutlook | null;
}): HomeNeedItem[] {
  const items: HomeNeedItem[] = [];

  for (const t of input.tasks) {
    if (t.status === "completed" || t.status === "cancelled") continue;
    const dr = datedReason(t.dueDate);
    if (dr) {
      items.push({ key: `task-${t.id}`, kind: "task", title: t.title, reason: dr.reason, tone: dr.tone, rank: dr.rank, task: t });
    } else if (t.priority === "critical") {
      items.push({ key: `task-${t.id}`, kind: "task", title: t.title, reason: "Critical priority", tone: "act", rank: 800, task: t });
    } else if (t.priority === "high") {
      items.push({ key: `task-${t.id}`, kind: "task", title: t.title, reason: "High priority", tone: "aware", rank: 600, task: t });
    }
  }

  for (const o of input.obligations) {
    if (OBLIGATION_CLOSED.has(o.status)) continue;
    const dr = datedReason(o.startDate);
    if (dr) {
      items.push({ key: `obl-${o.id}`, kind: "obligation", title: o.title, reason: dr.reason, tone: dr.tone, rank: dr.rank });
    }
  }

  if (input.finances && input.finances.overdueCount > 0) {
    const n = input.finances.overdueCount;
    items.push({ key: "bills-overdue", kind: "bill", title: `${plural(n, "overdue bill")}`, reason: "Overdue", tone: "act", rank: 950 });
  }

  return items.sort((a, b) => b.rank - a.rank);
}
