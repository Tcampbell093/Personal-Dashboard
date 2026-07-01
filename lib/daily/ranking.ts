/* =============================================================================
 * Daily Command Center — Slice 2: deterministic ranking + bounded selection.
 *
 * Pure, inspectable, deterministic. Given collected signals (Slice 2 orchestrator)
 * it excludes stale/invalid/suppressed signals, dedupes by key, scores each with
 * bounded integer components from documented registries, and selects AT MOST one
 * risk, one opportunity, and one recommended move — returning `null` for any slot
 * whose best candidate does not clear its threshold. NO AI, NO persistence, NO
 * randomness, NO dependence on provider completion order. A weak item is never
 * promoted to fill a slot. See docs/DAILY_COMMAND_CENTER_SPEC.md §5–§9.
 * ===========================================================================*/

import { type DailySignal, type DailyDomain, dayDiff } from "./contract";
import type { CollectedSignals } from "./orchestrator";

/* ------------------------------------------------ registries (§4) --------- */
/** Base weights for RISK candidacy. A type NOT listed here is never a risk. */
export const RISK_BASE_WEIGHTS: Record<string, number> = {
  projected_shortfall: 40, payment_overdue: 38, bill_overdue: 36, cash_flow_conflict: 34,
  obligation_overdue: 30, task_overdue: 28, collection_unverified: 26, bill_due_soon: 24,
  payment_due_soon: 24, utilization_high: 22, obligation_due_soon: 20, task_due_soon: 18,
  recent_hard_inquiries: 16, tight_cash_before_payday: 16, stale_credit_score: 10,
  uncategorized_transactions: 8, pending_matches: 8,
};
/** Base weights for OPPORTUNITY candidacy. A type NOT listed here is never an opportunity. */
export const OPPORTUNITY_BASE_WEIGHTS: Record<string, number> = {
  spending_opportunity: 28, credit_action: 26, utilization_progress: 18, collection_resolution_progress: 18,
  goal_progress: 14, planned_experience: 10, uncategorized_transactions: 8, pending_matches: 8,
};

export const RISK_MIN = 40, OPPORTUNITY_MIN = 35, MOVE_MIN = 45;

/** Broad financial family for the diversity rule (§8). `data_quality` is financial here
 * because every current data-quality signal is financial (categorization/matches/score). */
export const FINANCIAL_FAMILY = new Set<DailyDomain>(["bills", "finance", "credit", "spending", "goals", "data_quality"]);
const NONFINANCIAL = new Set<DailyDomain>(["tasks", "obligations", "experience"]);
export const DIVERSITY_NEAR_POINTS = 10;

/* ------------------------------------------------ ranking context --------- */
/** Grounded capacity for the capacity-fit component (§5). No inferred mood/health. */
export interface RankingContext {
  today: string;
  availableCash?: number | null;   // e.g. computeFinancialOutlook.estimatedRemaining (null = unknown)
  suppressedKeys?: Set<string>;    // in-memory only (§10) — NOT durable lifecycle state
}

/* ------------------------------------------------ score components -------- */
const urgencyPts = (u: DailySignal["urgency"]) => (u === "high" ? 20 : u === "medium" ? 10 : 0);
const confidencePts = (c: DailySignal["confidence"]) => (c === "high" ? 10 : c === "medium" ? 5 : 0);

/** Deadline proximity ordinal + points (overdue > today > soon), matching lib/briefing.ts. */
function deadlineBucket(effectiveDate: string | null, today: string): { pts: number; ord: number } {
  if (!effectiveDate) return { pts: 0, ord: 0 };
  const d = dayDiff(effectiveDate, today);
  if (d < -7) return { pts: 20, ord: 6 };        // overdue > 7 days
  if (d < 0) return { pts: 18, ord: 5 };         // overdue 1–7 days
  if (d === 0) return { pts: 16, ord: 4 };       // due today
  if (d === 1) return { pts: 12, ord: 3 };       // due tomorrow
  if (d <= 3) return { pts: 8, ord: 2 };         // due in 2–3 days
  if (d <= 7) return { pts: 4, ord: 1 };         // due in 4–7 days
  return { pts: 0, ord: 0 };                     // later
}

function freshnessPts(observedDate: string, today: string): number {
  const age = dayDiff(today, observedDate);
  if (age <= 0) return 4;         // observed today (or future-stamped → treat as today)
  if (age <= 7) return 2;         // within the last 7 days
  return 0;                       // older but still non-stale
}

const actionabilityPts = (s: DailySignal) => (s.candidateAction ? 8 : 0);

/** Grounded money required for friction/tie-break: the structured cost, else structured capacity money. */
const moneyRequired = (s: DailySignal): number | null =>
  s.estimatedCost != null ? s.estimatedCost : (s.capacityReqs?.money ?? null);

/** Grounded time (minutes): ONLY the structured field — never parse free-text `timeRequired`. */
const timeMinutes = (s: DailySignal): number | null => s.capacityReqs?.timeMinutes ?? null;

function moneyFriction(s: DailySignal): number {
  const m = moneyRequired(s);
  if (m == null || m === 0) return 0;
  if (m <= 25) return -1;
  if (m <= 100) return -3;
  return -6;
}
function timeFriction(s: DailySignal): number {
  const t = timeMinutes(s);
  if (t == null || t <= 15) return 0;
  if (t <= 30) return -1;
  if (t <= 60) return -3;
  return -5;
}
const frictionPts = (s: DailySignal) => moneyFriction(s) + timeFriction(s);

/** Capacity fit for the MOVE slot. Returns points, or `"exclude"` for known unsafe/impossible. */
function capacityFit(s: DailySignal, ctx: RankingContext): number | "exclude" {
  if (s.capacityReqs?.scheduleConflict === true) return "exclude"; // known hard conflict
  const need = moneyRequired(s);
  if (need == null || need === 0) return 5;        // nothing to afford + no known conflict → affordable
  if (ctx.availableCash == null) return 0;          // capacity unknown — NOT false-safe
  if (need <= ctx.availableCash) return 5;          // clearly affordable
  if (ctx.availableCash > 0) return -8;             // tight but possible (explicit warning)
  return "exclude";                                 // required money with no buffer → unsafe/impossible
}

/* ------------------------------------------------ breakdown + scoring ----- */
export interface ScoreBreakdown {
  base: number | null; urgency: number; deadline: number; confidence: number;
  freshness: number; actionability: number; capacityFit: number | "excluded"; friction: number; total: number;
}
export interface SlotEval { score: number | null; eligible: boolean; exclusions: string[]; breakdown: ScoreBreakdown; }
export interface RankedSignal { signal: DailySignal; deadlineOrd: number; risk: SlotEval; opportunity: SlotEval; move: SlotEval; }

const inferredNeedsConfidence = (s: DailySignal) => s.class === "inferred_interpretation" && s.confidence === "low";

function evalRisk(s: DailySignal, dl: { pts: number }, today: string): SlotEval {
  const exclusions: string[] = [];
  const base = RISK_BASE_WEIGHTS[s.signalType];
  const urgency = urgencyPts(s.urgency), deadline = dl.pts, confidence = confidencePts(s.confidence), freshness = freshnessPts(s.observedDate, today);
  const total = base != null ? base + urgency + deadline + confidence + freshness : 0;
  if (base == null) exclusions.push("type_not_in_risk_registry");
  if (inferredNeedsConfidence(s)) exclusions.push("inferred_interpretation_below_medium_confidence");
  if (base != null && total < RISK_MIN) exclusions.push(`below_risk_threshold(${total}<${RISK_MIN})`);
  const eligible = base != null && !inferredNeedsConfidence(s) && total >= RISK_MIN;
  return { score: base != null ? total : null, eligible, exclusions, breakdown: { base: base ?? null, urgency, deadline, confidence, freshness, actionability: 0, capacityFit: 0, friction: 0, total: base != null ? total : 0 } };
}

function evalOpportunity(s: DailySignal, today: string): SlotEval {
  const exclusions: string[] = [];
  const base = OPPORTUNITY_BASE_WEIGHTS[s.signalType];
  const urgency = urgencyPts(s.urgency), confidence = confidencePts(s.confidence), freshness = freshnessPts(s.observedDate, today), actionability = actionabilityPts(s), friction = frictionPts(s);
  const total = base != null ? base + urgency + confidence + freshness + actionability + friction : 0;
  if (base == null) exclusions.push("type_not_in_opportunity_registry");
  if (s.confidence === "low") exclusions.push("low_confidence_not_eligible_for_opportunity");
  if (s.reversibility === "irreversible") exclusions.push("irreversible_action_excluded");
  if (base != null && total < OPPORTUNITY_MIN) exclusions.push(`below_opportunity_threshold(${total}<${OPPORTUNITY_MIN})`);
  const eligible = base != null && s.confidence !== "low" && s.reversibility !== "irreversible" && total >= OPPORTUNITY_MIN;
  return { score: base != null ? total : null, eligible, exclusions, breakdown: { base: base ?? null, urgency, deadline: 0, confidence, freshness, actionability, capacityFit: 0, friction, total: base != null ? total : 0 } };
}

function evalMove(s: DailySignal, risk: SlotEval, opp: SlotEval, ctx: RankingContext): SlotEval {
  const exclusions: string[] = [];
  const bestBase = Math.max(risk.score ?? Number.NEGATIVE_INFINITY, opp.score ?? Number.NEGATIVE_INFINITY);
  const hasBase = Number.isFinite(bestBase);
  const actionability = actionabilityPts(s), friction = frictionPts(s);
  const cap = capacityFit(s, ctx);
  if (!s.candidateAction) exclusions.push("no_candidate_action");
  if (s.reversibility === "irreversible") exclusions.push("irreversible_excluded");
  if (inferredNeedsConfidence(s)) exclusions.push("low_confidence_inferred_excluded");
  if (cap === "exclude") exclusions.push("capacity_known_unsafe_or_impossible");
  if (!hasBase) exclusions.push("not_a_risk_or_opportunity_candidate");
  const capPts = cap === "exclude" ? 0 : cap;
  const total = hasBase ? bestBase + actionability + capPts + friction : 0;
  if (hasBase && total < MOVE_MIN) exclusions.push(`below_move_threshold(${total}<${MOVE_MIN})`);
  const eligible = hasBase && !!s.candidateAction && s.reversibility !== "irreversible" && !inferredNeedsConfidence(s) && cap !== "exclude" && total >= MOVE_MIN;
  return { score: hasBase ? total : null, eligible, exclusions, breakdown: { base: hasBase ? bestBase : null, urgency: 0, deadline: 0, confidence: 0, freshness: 0, actionability, capacityFit: cap === "exclude" ? "excluded" : cap, friction, total: hasBase ? total : 0 } };
}

/* ------------------------------------------------ dedupe + stale (§3) ----- */
const confRank = (c: DailySignal["confidence"]) => (c === "high" ? 3 : c === "medium" ? 2 : 1);
/** Winner among duplicate keys: valid non-stale (already filtered) → higher confidence →
 * newer observedDate → stable provider order (array index). Returns winnerIndex. */
function pickDuplicateWinner(a: { s: DailySignal; i: number }, b: { s: DailySignal; i: number }): { s: DailySignal; i: number } {
  const c = confRank(b.s.confidence) - confRank(a.s.confidence); if (c !== 0) return c < 0 ? a : b;
  const d = b.s.observedDate.localeCompare(a.s.observedDate); if (d !== 0) return d < 0 ? a : b; // newer first
  return a.i <= b.i ? a : b; // stable provider order
}

/* ------------------------------------------------ tie-breaking (§7) ------- */
function tieBreak(a: RankedSignal, b: RankedSignal): number {
  const u = urgencyPts(b.signal.urgency) - urgencyPts(a.signal.urgency); if (u) return u; // higher urgency
  const dl = b.deadlineOrd - a.deadlineOrd; if (dl) return dl;                              // nearer/overdue first
  const cf = confRank(b.signal.confidence) - confRank(a.signal.confidence); if (cf) return cf; // higher confidence
  const am = (moneyRequired(a.signal) ?? 0) - (moneyRequired(b.signal) ?? 0); if (am) return am; // lower money
  const at = (timeMinutes(a.signal) ?? 0) - (timeMinutes(b.signal) ?? 0); if (at) return at;     // lower time
  return a.signal.key.localeCompare(b.signal.key);                                         // stable key asc
}
const bySlot = (slot: "risk" | "opportunity" | "move") => (a: RankedSignal, b: RankedSignal) => {
  const sa = a[slot].score ?? Number.NEGATIVE_INFINITY, sb = b[slot].score ?? Number.NEGATIVE_INFINITY;
  if (sb !== sa) return sb - sa;
  return tieBreak(a, b);
};

/* ------------------------------------------------ output contracts (§11) -- */
export interface SelectionResult { signalKey: string | null; score: number | null; reasonSelected: string; }
export interface DailySelection {
  collectedAt: string;
  degraded: CollectedSignals["degraded"];
  invalid: CollectedSignals["invalid"];
  staleExcluded: { key: string; staleDate: string }[];
  deduped: { key: string; suppressedKey: string; reason: string }[];
  suppressed: { key: string; reason: string }[];
  ranked: RankedSignal[];
  risk: SelectionResult;
  opportunity: SelectionResult;
  recommendedMove: SelectionResult;
}

const NONE = (why = "no_candidate_cleared_threshold"): SelectionResult => ({ signalKey: null, score: null, reasonSelected: why });
const isFinancial = (d: DailyDomain) => FINANCIAL_FAMILY.has(d);

/* ------------------------------------------------ rank + select ----------- */
export function rankSignals(collected: CollectedSignals, ctx: RankingContext): DailySelection {
  const today = ctx.today;
  const suppressedKeys = ctx.suppressedKeys ?? new Set<string>();
  const staleExcluded: DailySelection["staleExcluded"] = [];
  const suppressed: DailySelection["suppressed"] = [];
  const deduped: DailySelection["deduped"] = [];

  // 1. exclude stale (staleDate < today) and suppressed keys.
  const live: { s: DailySignal; i: number }[] = [];
  collected.signals.forEach((s, i) => {
    if (s.staleDate < today) { staleExcluded.push({ key: s.key, staleDate: s.staleDate }); return; }
    if (suppressedKeys.has(s.key)) { suppressed.push({ key: s.key, reason: "suppressed_key (in-memory, non-durable)" }); return; }
    live.push({ s, i });
  });

  // 2. dedupe identical keys (no evidence merging — pick a single winner, record the loser).
  const byKey = new Map<string, { s: DailySignal; i: number }>();
  for (const cur of live) {
    const prev = byKey.get(cur.s.key);
    if (!prev) { byKey.set(cur.s.key, cur); continue; }
    const winner = pickDuplicateWinner(prev, cur);
    const loser = winner === prev ? cur : prev;
    byKey.set(cur.s.key, winner);
    deduped.push({ key: cur.s.key, suppressedKey: loser.s.key, reason: "duplicate_key_lower_priority (confidence→observedDate→provider_order)" });
  }
  const unique = [...byKey.values()].sort((a, b) => a.i - b.i).map((x) => x.s);

  // 3. score every unique signal (deterministic, provider-order independent).
  const ranked: RankedSignal[] = unique.map((s) => {
    const dl = deadlineBucket(s.effectiveDate, today);
    const risk = evalRisk(s, dl, today);
    const opportunity = evalOpportunity(s, today);
    const move = evalMove(s, risk, opportunity, ctx);
    return { signal: s, deadlineOrd: dl.ord, risk, opportunity, move };
  });

  // 4. select risk (highest eligible) + financial-family diversity guard.
  const riskCands = ranked.filter((r) => r.risk.eligible).sort(bySlot("risk"));
  let riskPick: RankedSignal | null = riskCands[0] ?? null;
  let riskReason = riskPick ? "highest_risk_score" : "no_candidate_cleared_threshold";
  if (riskPick && isFinancial(riskPick.signal.domain) && riskPick.signal.urgency !== "high") {
    const nonFin = riskCands.find((r) => NONFINANCIAL.has(r.signal.domain));
    if (nonFin && (nonFin.risk.score ?? 0) >= (riskPick.risk.score ?? 0) - DIVERSITY_NEAR_POINTS) {
      riskPick = nonFin; riskReason = "selected_through_domain_diversity_rule";
    }
  }

  // 5. select opportunity (prefer a domain different from the risk) + diversity guard.
  const oppCands = ranked.filter((r) => r.opportunity.eligible && r.signal.key !== riskPick?.signal.key).sort(bySlot("opportunity"));
  const oppDiff = oppCands.find((r) => r.signal.domain !== riskPick?.signal.domain);
  let oppPick: RankedSignal | null = oppDiff ?? oppCands[0] ?? null;
  let oppReason = !oppPick ? "no_candidate_cleared_threshold" : oppDiff ? "highest_opportunity_from_different_domain_than_risk" : "highest_opportunity_score";
  if (oppPick && isFinancial(oppPick.signal.domain)) {
    const nonFin = oppCands.find((r) => NONFINANCIAL.has(r.signal.domain));
    if (nonFin && (nonFin.opportunity.score ?? 0) >= (oppPick.opportunity.score ?? 0) - DIVERSITY_NEAR_POINTS && nonFin.signal.key !== oppPick.signal.key) {
      oppPick = nonFin; oppReason = "selected_through_domain_diversity_rule";
    }
  }

  // 6. select the single recommended move (highest eligible move; may reuse risk/opp signal).
  const moveCands = ranked.filter((r) => r.move.eligible).sort(bySlot("move"));
  const movePick = moveCands[0] ?? null;
  const moveReason = movePick ? "highest_actionable_move_after_capacity_check" : "no_candidate_cleared_threshold";

  return {
    collectedAt: collected.collectedAt, degraded: collected.degraded, invalid: collected.invalid,
    staleExcluded, deduped, suppressed, ranked,
    risk: riskPick ? { signalKey: riskPick.signal.key, score: riskPick.risk.score, reasonSelected: riskReason } : NONE(),
    opportunity: oppPick ? { signalKey: oppPick.signal.key, score: oppPick.opportunity.score, reasonSelected: oppReason } : NONE(),
    recommendedMove: movePick ? { signalKey: movePick.signal.key, score: movePick.move.score, reasonSelected: moveReason } : NONE(),
  };
}
