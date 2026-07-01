/* =============================================================================
 * Daily Command Center — Slice 1: grounded read-only signal providers.
 *
 * Each provider maps an EXISTING domain service into the shared DailySignal
 * contract. They REUSE existing services (no duplicated business logic), return
 * only owner-scoped data, and MUTATE NOTHING. NO ranking, orchestration,
 * persistence, API, UI, or AI here (those are later slices). Providers are
 * independent — there is intentionally no cross-domain collect/merge function.
 *
 * Provenance classes are assigned honestly (see docs/DAILY_COMMAND_CENTER_SPEC.md
 * §4). Unknown is distinguished from zero/none. Missing data never becomes a
 * false positive: a provider returns [] when nothing grounded qualifies.
 * ===========================================================================*/

import {
  type DailySignal, type SignalContext, type DailySignalProvider,
  DEFAULT_FRESHNESS_DAYS, isoAddDays, dayDiff, datedUrgency,
} from "./contract";

import { listTasks, toTaskViews } from "@/lib/services/tasks";
import { listObligations, toObligationViews } from "@/lib/services/obligations";
import { listBills, toBillViews } from "@/lib/services/finances";
import { computeFinancialOutlook } from "@/lib/services/finances";
import { countUncategorized } from "@/lib/services/categories";
import { countPendingMatches } from "@/lib/services/matching";
import { computeInsights } from "@/lib/services/insights";
import { computeCreditOverview } from "@/lib/services/credit";
import { listPlanned, toExperienceViews } from "@/lib/services/experiences";

const OBLIGATION_CLOSED = new Set(["done", "cancelled", "missed"]);
const ATTENTION_HORIZON_DAYS = 3;
const money = (n: number) => `$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
/** stale window for a dated fact: a grace period past the deadline, else a bounded look-forward. */
const staleFor = (effectiveDate: string | null, ctx: SignalContext) =>
  effectiveDate ? isoAddDays(effectiveDate, 3) : isoAddDays(ctx.today, ctx.freshnessDays ?? DEFAULT_FRESHNESS_DAYS);

/* ------------------------------------------------------------- tasks ------ */
export const tasksProvider: DailySignalProvider = {
  domain: "tasks",
  async getDailySignals(userId, ctx) {
    const tasks = toTaskViews(await listTasks(userId));
    const out: DailySignal[] = [];
    for (const t of tasks) {
      if (t.status === "completed" || t.status === "cancelled") continue; // completed → no active overdue signal
      if (!t.dueDate) continue; // unknown due date ≠ overdue (do not fabricate)
      const d = dayDiff(t.dueDate, ctx.today);
      if (d > ATTENTION_HORIZON_DAYS) continue; // only pressing items become signals in this domain
      const overdue = d < 0;
      out.push({
        key: `tasks:${overdue ? "task_overdue" : "task_due_soon"}:${t.id}`,
        domain: "tasks", signalType: overdue ? "task_overdue" : "task_due_soon", class: "observed_fact",
        title: overdue ? `Task overdue: ${t.title}` : `Task due soon: ${t.title}`,
        summary: overdue ? `"${t.title}" was due ${t.dueDate} and is not complete.` : `"${t.title}" is due ${t.dueDate}.`,
        evidence: `due ${t.dueDate}, priority ${t.priority}, status ${t.status}`,
        sourceRefs: [{ service: "tasks", table: "tasks", id: t.id, label: t.title }],
        observedDate: ctx.today, effectiveDate: t.dueDate,
        urgency: datedUrgency(t.dueDate, ctx.today), confidence: "high",
        estimatedUpside: null, estimatedDownside: overdue ? "Overdue commitments can compound." : null,
        estimatedCost: null, timeRequired: null, reversibility: "reversible",
        capacityReqs: { timeMinutes: null, scheduleConflict: null }, requiredVerification: null,
        candidateAction: `Complete or reschedule "${t.title}".`, staleDate: staleFor(t.dueDate, ctx),
        reasonCodes: [overdue ? "task_overdue" : "task_due_soon", `priority_${t.priority}`],
      });
    }
    return out;
  },
};

/* -------------------------------------------------------- obligations ----- */
export const obligationsProvider: DailySignalProvider = {
  domain: "obligations",
  async getDailySignals(userId, ctx) {
    const obligations = toObligationViews(await listObligations(userId));
    const out: DailySignal[] = [];
    for (const o of obligations) {
      if (OBLIGATION_CLOSED.has(o.status)) continue;
      if (!o.startDate) continue;
      const d = dayDiff(o.startDate, ctx.today);
      if (d > 14) continue; // bounded upcoming window
      const type = d < 0 ? "obligation_overdue" : d <= ATTENTION_HORIZON_DAYS ? "obligation_due_soon" : "obligation_upcoming";
      out.push({
        key: `obligations:${type}:${o.id}`,
        domain: "obligations", signalType: type, class: "observed_fact",
        title: d < 0 ? `Obligation passed: ${o.title}` : `Obligation ${d === 0 ? "today" : "upcoming"}: ${o.title}`,
        summary: `${o.title}${o.location ? ` at ${o.location}` : ""} is scheduled for ${o.startDate}.`,
        evidence: `starts ${o.startDate}, type ${o.type}, importance ${o.importance}, status ${o.status}`,
        sourceRefs: [{ service: "obligations", table: "obligations", id: o.id, label: o.title }],
        observedDate: ctx.today, effectiveDate: o.startDate,
        urgency: datedUrgency(o.startDate, ctx.today), confidence: "high",
        estimatedUpside: null, estimatedDownside: null, estimatedCost: null, timeRequired: null,
        reversibility: "reversible", capacityReqs: { scheduleConflict: null }, requiredVerification: null,
        candidateAction: `Review the "${o.title}" obligation.`, staleDate: staleFor(o.startDate, ctx),
        reasonCodes: [type, `importance_${o.importance}`],
      });
    }
    return out;
  },
};

/* ----------------------------------------------------------- bills -------- */
export const billsProvider: DailySignalProvider = {
  domain: "bills",
  async getDailySignals(userId, ctx) {
    const bills = toBillViews(await listBills(userId));
    const out: DailySignal[] = [];
    for (const b of bills) {
      if (b.status === "paid") continue; // paid bills emit no due signal
      if (!b.dueDate) continue; // unknown due date ≠ due
      const d = dayDiff(b.dueDate, ctx.today);
      if (d > ATTENTION_HORIZON_DAYS) continue;
      const overdue = d < 0;
      out.push({
        key: `bills:${overdue ? "bill_overdue" : "bill_due_soon"}:${b.id}`,
        domain: "bills", signalType: overdue ? "bill_overdue" : "bill_due_soon", class: "observed_fact",
        title: overdue ? `Bill overdue: ${b.name}` : `Bill due soon: ${b.name}`,
        summary: `${b.name} (${money(b.expectedAmount)}) is due ${b.dueDate}${overdue ? " and is not marked paid" : ""}.`,
        evidence: `due ${b.dueDate}, amount ${money(b.expectedAmount)}, status ${b.status}`,
        sourceRefs: [{ service: "finances.bills", table: "financial_entries", id: b.id, label: b.name }],
        observedDate: ctx.today, effectiveDate: b.dueDate,
        urgency: datedUrgency(b.dueDate, ctx.today), confidence: "high",
        estimatedUpside: null, estimatedDownside: overdue ? "Late bills can incur fees or affect standing." : null,
        estimatedCost: b.expectedAmount, timeRequired: null, reversibility: "reversible",
        capacityReqs: { money: b.expectedAmount, scheduleConflict: null },
        requiredVerification: "Confirm the amount and that it is not already paid.",
        candidateAction: `Review the ${b.name} bill due ${b.dueDate}.`, staleDate: staleFor(b.dueDate, ctx),
        reasonCodes: [overdue ? "bill_overdue" : "bill_due_soon"],
      });
    }
    return out;
  },
};

/* --------------------------------------------------------- finance -------- */
export const financeProvider: DailySignalProvider = {
  domain: "finance",
  async getDailySignals(userId, ctx) {
    const o = await computeFinancialOutlook(userId);
    const out: DailySignal[] = [];
    const stale = isoAddDays(ctx.today, ctx.freshnessDays ?? DEFAULT_FRESHNESS_DAYS);
    if (o.estimatedRemaining < 0) {
      out.push({
        key: `finance:projected_shortfall:owner`,
        domain: "finance", signalType: "projected_shortfall", class: "deterministic_calc",
        title: "Projected cash shortfall before payday",
        summary: `Estimated remaining cash after upcoming bills is ${money(o.estimatedRemaining)}${o.nextPaydayDate ? ` before your next expected payday (${o.nextPaydayDate})` : ""}.`,
        evidence: `estimatedRemaining ${money(o.estimatedRemaining)}, billsDueBeforePayday ${money(o.billsDueBeforePayday)}`,
        sourceRefs: [{ service: "finances.outlook", table: null, id: null, label: "financial outlook" }],
        observedDate: ctx.today, effectiveDate: o.nextPaydayDate,
        urgency: "high", confidence: "medium",
        estimatedUpside: null, estimatedDownside: "May be unable to cover upcoming bills before payday.",
        estimatedCost: null, timeRequired: null, reversibility: "reversible",
        capacityReqs: { money: Math.abs(Math.round(o.estimatedRemaining)) }, requiredVerification: "Confirm balances and upcoming bills are current.",
        candidateAction: "Review upcoming bills and available cash before payday.", staleDate: stale,
        reasonCodes: ["projected_shortfall"],
      });
    } else if (o.billsDueBeforePayday > 0 && o.estimatedRemaining < o.billsDueBeforePayday) {
      out.push({
        key: `finance:tight_cash_before_payday:owner`,
        domain: "finance", signalType: "tight_cash_before_payday", class: "deterministic_calc",
        title: "Cash may be tight before payday",
        summary: `Bills due before payday total ${money(o.billsDueBeforePayday)}; estimated remaining is ${money(o.estimatedRemaining)}.`,
        evidence: `billsDueBeforePayday ${money(o.billsDueBeforePayday)}, estimatedRemaining ${money(o.estimatedRemaining)}`,
        sourceRefs: [{ service: "finances.outlook", table: null, id: null, label: "financial outlook" }],
        observedDate: ctx.today, effectiveDate: o.nextPaydayDate,
        urgency: "medium", confidence: "medium",
        estimatedUpside: null, estimatedDownside: "Limited buffer before the next paycheck.",
        estimatedCost: null, timeRequired: null, reversibility: "reversible",
        capacityReqs: { money: Math.round(o.billsDueBeforePayday) }, requiredVerification: "Confirm balances and bill due dates.",
        candidateAction: "Plan which bills to prioritize before payday.", staleDate: stale,
        reasonCodes: ["tight_cash_before_payday"],
      });
    }
    return out;
  },
};

/* ---------------------------------------------------------- credit -------- */
// Map credit observations (except goal_progress, owned by the goals provider) +
// credit action cards (recommendations). Reuses computeCreditOverview exactly.
const CREDIT_OBS_CLASS: Record<string, DailySignal["class"]> = {
  score_change: "deterministic_calc", utilization_high: "deterministic_calc", utilization_progress: "deterministic_calc",
  payment_due_soon: "observed_fact", payment_overdue: "observed_fact", collection_unverified: "observed_fact",
  collection_resolution_progress: "deterministic_calc", recent_hard_inquiries: "deterministic_calc",
  thin_or_incomplete_profile: "inferred_interpretation", cash_flow_conflict: "inferred_interpretation",
  data_update_needed: "deterministic_calc",
};
const CREDIT_OBS_TYPES = new Set(Object.keys(CREDIT_OBS_CLASS));

export const creditProvider: DailySignalProvider = {
  domain: "credit",
  async getDailySignals(userId, ctx) {
    const ov = await computeCreditOverview(userId, { now: ctx.today });
    const out: DailySignal[] = [];
    const stale = isoAddDays(ctx.today, ctx.freshnessDays ?? DEFAULT_FRESHNESS_DAYS);
    for (const o of ov.observations) {
      if (o.type === "goal_progress") continue; // owned by goalsProvider
      // data_update_needed is a data-quality concern → emitted by dataQualityProvider instead
      if (o.type === "data_update_needed") continue;
      if (!CREDIT_OBS_TYPES.has(o.type)) continue; // only mapped, grounded types
      const sig: DailySignal = {
        key: `credit:${o.type}:${o.key}`,
        domain: "credit", signalType: o.type as DailySignal["signalType"], class: CREDIT_OBS_CLASS[o.type],
        title: o.title, summary: o.summary, evidence: o.evidence,
        sourceRefs: [{ service: "credit", table: null, id: null, label: o.source ?? o.type }],
        observedDate: o.asOfDate ?? ctx.today, effectiveDate: null,
        urgency: o.type === "payment_overdue" || o.type === "cash_flow_conflict" ? "high" : o.type === "utilization_high" || o.type === "collection_unverified" || o.type === "recent_hard_inquiries" || o.type === "payment_due_soon" ? "medium" : "low",
        confidence: o.confidence, estimatedUpside: null, estimatedDownside: null, estimatedCost: null,
        timeRequired: null, reversibility: "reversible", capacityReqs: null,
        requiredVerification: /collection/.test(o.type) ? "Verify the debt and obtain written terms before paying." : null,
        candidateAction: null, staleDate: stale, reasonCodes: o.reasonCodes,
      };
      out.push(sig);
    }
    for (const a of ov.actions) {
      out.push({
        key: `credit:credit_action:${a.key}`,
        domain: "credit", signalType: "credit_action", class: "recommendation",
        title: a.title, summary: a.observation, evidence: a.evidence,
        sourceRefs: [{ service: "credit", table: null, id: null, label: a.actionType }],
        observedDate: ctx.today, effectiveDate: null,
        urgency: a.urgency, confidence: a.confidence,
        estimatedUpside: a.estimatedUpside, estimatedDownside: null, estimatedCost: a.estimatedCost,
        timeRequired: a.timeRequired, reversibility: "reversible", capacityReqs: a.estimatedCost != null ? { money: a.estimatedCost } : null,
        requiredVerification: a.verificationNeeded, candidateAction: a.nextStep, staleDate: stale,
        reasonCodes: [a.actionType, `risk_${a.riskLevel}`],
      });
    }
    return out;
  },
};

/* --------------------------------------------------------- spending ------- */
// Low-confidence opportunities stay suppressed (computeInsights default hides them).
export const spendingProvider: DailySignalProvider = {
  domain: "spending",
  async getDailySignals(userId, ctx) {
    const view = await computeInsights(userId, { period: "last_30", now: ctx.today });
    const stale = isoAddDays(ctx.today, 30); // period-scoped
    return view.opportunities.map((opp) => ({
      key: `spending:spending_opportunity:${opp.key}`,
      domain: "spending" as const, signalType: "spending_opportunity", class: "recommendation" as const,
      title: opp.observation.slice(0, 80), summary: opp.observation, evidence: `${opp.upsideLabel} · ${opp.evidencePeriod}`,
      sourceRefs: [{ service: "insights", table: null, id: null, label: opp.type }],
      observedDate: ctx.today, effectiveDate: null,
      urgency: "low" as const, confidence: opp.confidence,
      estimatedUpside: opp.upsideLabel, estimatedDownside: null,
      estimatedCost: opp.estimatedUpsideMax, timeRequired: null, reversibility: "reversible" as const,
      capacityReqs: null, requiredVerification: opp.limitation, candidateAction: opp.nextAction,
      staleDate: stale, reasonCodes: opp.reasonCodes,
    }));
  },
};

/* ----------------------------------------------------------- goals -------- */
// The ONLY implemented goals are credit goals (spec §0). Maps credit goalProgress.
export const goalsProvider: DailySignalProvider = {
  domain: "goals",
  async getDailySignals(userId, ctx) {
    const ov = await computeCreditOverview(userId, { now: ctx.today });
    const stale = isoAddDays(ctx.today, ctx.freshnessDays ?? DEFAULT_FRESHNESS_DAYS);
    return ov.goalProgress.filter((g) => g.status === "active").map((g) => ({
      key: `goals:goal_progress:${g.id}`,
      domain: "goals" as const, signalType: "goal_progress", class: "deterministic_calc" as const,
      title: `Credit goal: ${g.goalType.replace(/_/g, " ")}`,
      summary: `${g.goalType.replace(/_/g, " ")} → target ${g.targetValue}${g.progressPct != null ? ` · ${Math.round(g.progressPct)}% progress` : ""}${g.onTrack != null ? (g.onTrack ? " · on track" : " · behind") : ""}.`,
      evidence: `current ${g.currentValue ?? "unknown"}, target ${g.targetValue}`,
      sourceRefs: [{ service: "credit.goals", table: "credit_goals", id: g.id, label: g.goalType }],
      observedDate: ctx.today, effectiveDate: null,
      urgency: "low" as const, confidence: "medium" as const,
      estimatedUpside: null, estimatedDownside: null, estimatedCost: null, timeRequired: null,
      reversibility: "reversible" as const, capacityReqs: null, requiredVerification: null,
      candidateAction: null, staleDate: stale,
      reasonCodes: ["goal_progress", g.onTrack === false ? "behind" : g.onTrack === true ? "on_track" : "progress_unknown"],
    }));
  },
};

/* ------------------------------------------------------ data quality ------ */
export const dataQualityProvider: DailySignalProvider = {
  domain: "data_quality",
  async getDailySignals(userId, ctx) {
    const out: DailySignal[] = [];
    const stale = isoAddDays(ctx.today, ctx.freshnessDays ?? DEFAULT_FRESHNESS_DAYS);
    const [uncat, pending] = await Promise.all([countUncategorized(userId), countPendingMatches(userId)]);
    if (uncat > 0) out.push({
      key: `data_quality:uncategorized_transactions:owner`,
      domain: "data_quality", signalType: "uncategorized_transactions", class: "deterministic_calc",
      title: `${uncat} transaction${uncat === 1 ? "" : "s"} need categorization`,
      summary: `${uncat} active transaction${uncat === 1 ? " is" : "s are"} not yet categorized — category insights improve as you categorize.`,
      evidence: `uncategorized count ${uncat}`,
      sourceRefs: [{ service: "categories", table: "transaction_category_assignments", id: null, label: "uncategorized" }],
      observedDate: ctx.today, effectiveDate: null, urgency: "low", confidence: "high",
      estimatedUpside: "Better insight accuracy", estimatedDownside: null, estimatedCost: null, timeRequired: null,
      reversibility: "reversible", capacityReqs: null, requiredVerification: null,
      candidateAction: "Open Categorize transactions.", staleDate: stale, reasonCodes: ["uncategorized_coverage_low"],
    });
    if (pending > 0) out.push({
      key: `data_quality:pending_matches:owner`,
      domain: "data_quality", signalType: "pending_matches", class: "deterministic_calc",
      title: `${pending} transaction match${pending === 1 ? "" : "es"} need review`,
      summary: `${pending} suggested transaction match${pending === 1 ? "" : "es"} await your confirmation.`,
      evidence: `pending matches ${pending}`,
      sourceRefs: [{ service: "matching", table: "transaction_match_suggestions", id: null, label: "pending matches" }],
      observedDate: ctx.today, effectiveDate: null, urgency: "low", confidence: "high",
      estimatedUpside: null, estimatedDownside: null, estimatedCost: null, timeRequired: null,
      reversibility: "reversible", capacityReqs: null, requiredVerification: null,
      candidateAction: "Review suggested matches.", staleDate: stale, reasonCodes: ["pending_matches"],
    });
    // Stale credit score is a data-quality concern (surfaced here rather than as a substantive credit signal).
    const ov = await computeCreditOverview(userId, { now: ctx.today });
    if (ov.staleScore && ov.scores[0]) {
      const s = ov.scores[0];
      out.push({
        key: `data_quality:stale_credit_score:owner`,
        domain: "data_quality", signalType: "stale_credit_score", class: "deterministic_calc",
        title: "Credit score data is stale",
        summary: `Your most recent score (${s.source}, ${s.asOfDate}) is over 45 days old — consider updating it.`,
        evidence: `latest score as of ${s.asOfDate}`,
        sourceRefs: [{ service: "credit", table: "credit_score_snapshots", id: s.id, label: s.source }],
        observedDate: ctx.today, effectiveDate: null, urgency: "low", confidence: "high",
        estimatedUpside: null, estimatedDownside: "Guidance is only as current as manual data.", estimatedCost: null,
        timeRequired: null, reversibility: "reversible", capacityReqs: null, requiredVerification: null,
        candidateAction: "Record your latest score.", staleDate: stale, reasonCodes: ["stale_score"],
      });
    }
    return out;
  },
};

/* -------------------------------------------------------- experience ------ */
// Grounded only: a planned experience that has an actual plannedDate.
export const experienceProvider: DailySignalProvider = {
  domain: "experience",
  async getDailySignals(userId, ctx) {
    const planned = toExperienceViews(await listPlanned(userId));
    const stale = isoAddDays(ctx.today, ctx.freshnessDays ?? DEFAULT_FRESHNESS_DAYS);
    return planned
      .filter((e) => e.plannedDate && dayDiff(e.plannedDate!, ctx.today) >= 0 && dayDiff(e.plannedDate!, ctx.today) <= 30)
      .map((e) => ({
        key: `experience:planned_experience:${e.id}`,
        domain: "experience" as const, signalType: "planned_experience", class: "observed_fact" as const,
        title: `Planned experience: ${e.title}`,
        summary: `"${e.title}" is planned for ${e.plannedDate}.`,
        evidence: `planned date ${e.plannedDate}`,
        sourceRefs: [{ service: "experiences", table: "experiences", id: e.id, label: e.title }],
        observedDate: ctx.today, effectiveDate: e.plannedDate,
        urgency: datedUrgency(e.plannedDate, ctx.today), confidence: "high" as const,
        estimatedUpside: null, estimatedDownside: null, estimatedCost: null, timeRequired: null,
        reversibility: "reversible" as const, capacityReqs: { scheduleConflict: null }, requiredVerification: null,
        candidateAction: `Review the "${e.title}" experience.`, staleDate: staleFor(e.plannedDate, ctx),
        reasonCodes: ["planned_experience"],
      }));
  },
};

/** All grounded providers (Slice 1). Exposed as a plain list for tests — this is
 * NOT orchestration: there is no cross-domain collect/merge/rank here. */
export const DAILY_SIGNAL_PROVIDERS: DailySignalProvider[] = [
  tasksProvider, obligationsProvider, billsProvider, financeProvider,
  creditProvider, spendingProvider, goalsProvider, dataQualityProvider, experienceProvider,
];
