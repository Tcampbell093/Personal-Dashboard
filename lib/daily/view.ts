/* =============================================================================
 * Daily Command Center — Slice 4: bounded PUBLIC view-model.
 *
 * Maps the internal engine output (CollectedSignals + DailySelection + lifecycle)
 * into a SAFE, bounded `DailyBriefView` for API responses. NEVER exposes raw
 * CollectedSignals, full ranked arrays, unrelated exclusion diagnostics, database
 * rows, SQL/stack text, raw provider errors, or secret payloads. Pure + read-only:
 * this module performs no DB or network access.
 * ===========================================================================*/

import { type DailySignal, type SourceRef, dayDiff } from "./contract";
import type { RankedSignal, DailySelection, SelectionResult } from "./ranking";
import type { LifecycleRow, ResponseValue, VerificationValue } from "./lifecycle";

/* ---------------------------------------------------- public shapes ------- */
export interface PublicBriefItem {
  key: string; domain: string; signalType: string; class: string;
  title: string; summary: string; evidence: string; sourceRefs: SourceRef[];
  effectiveDate: string | null; urgency: string; confidence: string; staleDate: string;
}
export interface PublicSelectedItem extends PublicBriefItem {
  estimatedUpside: string | null; estimatedDownside: string | null; estimatedCost: number | null;
  timeRequired: string | null; requiredVerification: string | null; score: number | null; reasonSelected: string;
}
export type CapacityResult = "ok" | "tight" | "unknown";
export interface PublicLifecycleState {
  key: string; response: ResponseValue; deferUntil: string | null;
  respondedAt: string | null; completedAt: string | null; outcomeNote: string | null;
  verificationState: VerificationValue; presentedCount: number; presentedOn: string | null;
}
export interface PublicRecommendedMove {
  key: string; title: string; summary: string; evidence: string; sourceRefs: SourceRef[];
  personalRelevance: string | null; expectedUpside: string | null; tradeoff: string | null;
  estimatedMoneyRequired: number | null; estimatedTimeRequired: string | null;
  urgency: string; confidence: string; capacity: CapacityResult;
  nextAction: string | null; requiredVerification: string | null; staleDate: string;
  score: number | null; reasonSelected: string; lifecycle: PublicLifecycleState | null;
}
export interface DailyBriefView {
  date: string;
  generatedAt: string;
  today: { items: PublicBriefItem[]; empty: boolean };
  whatChanged: { items: PublicBriefItem[]; state: "available" | "not_available"; message: string | null };
  risk: PublicSelectedItem | null;
  opportunity: PublicSelectedItem | null;
  recommendedMove: PublicRecommendedMove | null;
  degraded: { domain: string; message: string }[];
  lifecycle: { activeRecommendation: PublicLifecycleState | null };
}

/* ---------------------------------------------------- helpers ------------- */
const briefBase = (s: DailySignal): PublicBriefItem => ({
  key: s.key, domain: s.domain, signalType: s.signalType, class: s.class,
  title: s.title, summary: s.summary, evidence: s.evidence, sourceRefs: s.sourceRefs,
  effectiveDate: s.effectiveDate, urgency: s.urgency, confidence: s.confidence, staleDate: s.staleDate,
});

function selectedItem(ranked: RankedSignal[], sel: SelectionResult): PublicSelectedItem | null {
  if (!sel.signalKey) return null;
  const r = ranked.find((x) => x.signal.key === sel.signalKey);
  if (!r) return null;
  const s = r.signal;
  return {
    ...briefBase(s),
    estimatedUpside: s.estimatedUpside, estimatedDownside: s.estimatedDownside, estimatedCost: s.estimatedCost,
    timeRequired: s.timeRequired, requiredVerification: s.requiredVerification,
    score: sel.score, reasonSelected: sel.reasonSelected,
  };
}

/** Grounded capacity result for the recommended move. Returns `unknown` when the
 * capacity fact is unavailable — NEVER "ok" merely because the capacity service failed. */
export function capacityResult(s: DailySignal, availableCash: number | null): CapacityResult {
  const need = s.estimatedCost != null ? s.estimatedCost : (s.capacityReqs?.money ?? null);
  if (s.capacityReqs?.scheduleConflict === true) return "tight"; // known conflict (unsafe is excluded before selection)
  if (need == null || need === 0) return "ok"; // nothing to afford + no known conflict
  if (availableCash == null) return "unknown"; // grounded capacity unavailable
  if (need <= availableCash) return "ok";
  return "tight";
}

export function toPublicLifecycle(row: LifecycleRow | null): PublicLifecycleState | null {
  if (!row) return null;
  return {
    key: row.recommendationKey, response: row.response as ResponseValue,
    deferUntil: (row.deferUntil as unknown as string | null) ?? null,
    respondedAt: row.respondedAt ? row.respondedAt.toISOString() : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    outcomeNote: row.outcomeNote ?? null, verificationState: row.verificationState as VerificationValue,
    presentedCount: row.presentedCount, presentedOn: (row.presentedOn as unknown as string | null) ?? null,
  };
}

function recommendedMove(ranked: RankedSignal[], sel: SelectionResult, availableCash: number | null, lifecycle: PublicLifecycleState | null): PublicRecommendedMove | null {
  if (!sel.signalKey) return null;
  const r = ranked.find((x) => x.signal.key === sel.signalKey);
  if (!r) return null;
  const s = r.signal;
  return {
    key: s.key, title: s.title, summary: s.summary, evidence: s.evidence, sourceRefs: s.sourceRefs,
    personalRelevance: null, // not grounded in Slice-1 signals — never invented (spec §7)
    expectedUpside: s.estimatedUpside, tradeoff: s.estimatedDownside,
    estimatedMoneyRequired: s.estimatedCost != null ? s.estimatedCost : (s.capacityReqs?.money ?? null),
    estimatedTimeRequired: s.timeRequired, urgency: s.urgency, confidence: s.confidence,
    capacity: capacityResult(s, availableCash), nextAction: s.candidateAction,
    requiredVerification: s.requiredVerification, staleDate: s.staleDate,
    score: sel.score, reasonSelected: sel.reasonSelected, lifecycle,
  };
}

/** Deterministic, bounded Today section (spec §8): at most 3 concrete dated items
 * (tasks/obligations/bills) that are non-stale, non-suppressed, and overdue/due-soon.
 * Ordered overdue → today → soon, then higher urgency, then key asc (Slice-2 consistent).
 * No manufactured filler; empty when nothing qualifies. */
const TODAY_DOMAINS = new Set(["tasks", "obligations", "bills"]);
const TODAY_HORIZON_DAYS = 3;
const urgOrd = (u: string) => (u === "high" ? 3 : u === "medium" ? 2 : 1);
const deadlineOrd = (eff: string | null, today: string): number => {
  if (!eff) return -1;
  const d = dayDiff(eff, today);
  if (d < -7) return 6; if (d < 0) return 5; if (d === 0) return 4; if (d === 1) return 3; if (d <= 3) return 2; return -1;
};
export function buildToday(signals: DailySignal[], suppressed: Set<string>, today: string): PublicBriefItem[] {
  const seen = new Set<string>();
  const cands = signals.filter((s) =>
    TODAY_DOMAINS.has(s.domain) && s.effectiveDate != null && s.staleDate >= today && !suppressed.has(s.key)
    && dayDiff(s.effectiveDate, today) <= TODAY_HORIZON_DAYS);
  return cands
    .sort((a, b) =>
      deadlineOrd(b.effectiveDate, today) - deadlineOrd(a.effectiveDate, today)
      || urgOrd(b.urgency) - urgOrd(a.urgency)
      || a.key.localeCompare(b.key))
    .filter((s) => (seen.has(s.key) ? false : (seen.add(s.key), true))) // de-dupe exact keys
    .slice(0, 3)
    .map(briefBase);
}

/** The truthful Slice-4 "What changed" boundary — no `daily_brief_log` baseline exists yet. */
export const WHAT_CHANGED_UNAVAILABLE: DailyBriefView["whatChanged"] = {
  items: [], state: "not_available",
  message: "Change tracking is not available until a prior brief baseline exists.",
};

/* ---------------------------------------------------- assemble ------------ */
export interface BuildViewInput {
  today: string;
  generatedAt: string;
  signals: DailySignal[];            // contract-valid collected signals
  selection: DailySelection;
  suppressedKeys: Set<string>;
  availableCash: number | null;      // grounded capacity, or null when unavailable
  activeMoveRow: LifecycleRow | null; // active lifecycle row for the selected move key, if any
}
export function buildDailyBriefView(input: BuildViewInput): DailyBriefView {
  const { selection } = input;
  const moveLifecycle = toPublicLifecycle(input.activeMoveRow);
  const todayItems = buildToday(input.signals, input.suppressedKeys, input.today);
  return {
    date: input.today,
    generatedAt: input.generatedAt,
    today: { items: todayItems, empty: todayItems.length === 0 },
    whatChanged: WHAT_CHANGED_UNAVAILABLE,
    risk: selectedItem(selection.ranked, selection.risk),
    opportunity: selectedItem(selection.ranked, selection.opportunity),
    recommendedMove: recommendedMove(selection.ranked, selection.recommendedMove, input.availableCash, moveLifecycle),
    degraded: selection.degraded.map((d) => ({ domain: d.domain, message: `The ${d.domain} section is temporarily unavailable.` })),
    lifecycle: { activeRecommendation: moveLifecycle },
  };
}
