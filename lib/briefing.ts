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
  Tier,
} from "./types";

const PRIORITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const todayIso = () => new Date().toISOString().slice(0, 10);

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

/** Nearest upcoming obligation by start date. */
export function topObligation(obligations: ObligationView[]): ObligationView | null {
  const upcoming = [...obligations].sort((a, b) =>
    a.startDate.localeCompare(b.startDate),
  );
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

  const summary =
    `${openTaskCount} open ${openTaskCount === 1 ? "task" : "tasks"}, ` +
    `${input.obligations.length} upcoming ${input.obligations.length === 1 ? "obligation" : "obligations"}` +
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

const DAYS = (dateStr: string | null): number => {
  if (!dateStr) return Infinity;
  const target = new Date(dateStr + "T00:00:00");
  const now = new Date(todayIso() + "T00:00:00");
  return Math.round((target.getTime() - now.getTime()) / 86_400_000);
};

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
