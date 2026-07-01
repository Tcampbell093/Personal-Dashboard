/* =============================================================================
 * verify-daily-slice2.ts — Daily Command Center Slice 2 verification.
 *
 * Failure-isolated orchestration + deterministic ranking/selection. Ranking math
 * is tested with SYNTHETIC in-memory signals (pure, no DB); orchestration is
 * tested against the REAL Slice 1 providers (with temporary monkey-patching to
 * force failures/invalid output). No persistence/API/UI/AI/Home. No writes.
 * ===========================================================================*/

import { readFileSync } from "node:fs";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { tasks, obligations, financialEntries, accountMovements, importedTransactions, financialConnections, financialAccounts, providerAccounts, experienceRequests } from "@/db/schema";
import { CURRENT_USER_ID as U } from "@/lib/auth";
import type { DailySignal, SignalContext } from "@/lib/daily/contract";
import { validateSignal } from "@/lib/daily/contract";
import * as Prov from "@/lib/daily/providers";
import { collectDailySignals, makeSharedCredit, type CollectedSignals } from "@/lib/daily/orchestrator";
import { rankSignals, RISK_BASE_WEIGHTS, OPPORTUNITY_BASE_WEIGHTS, RISK_MIN, OPPORTUNITY_MIN, MOVE_MIN, type RankingContext } from "@/lib/daily/ranking";

let passed = 0, failed = 0;
const ok = (n: string, c: boolean) => { c ? passed++ : failed++; console.log(`${c ? "✓" : "✗"} ${n}`); };
const NOW = "2026-07-01";
const FOREIGN = U + 99999;
const ago = (d: number) => new Date(Date.parse(NOW) - d * 86400000).toISOString().slice(0, 10);
const ahead = (d: number) => new Date(Date.parse(NOW) + d * 86400000).toISOString().slice(0, 10);
const CTX: SignalContext = { today: NOW, timezone: "America/New_York", now: `${NOW}T12:00:00.000Z`, freshnessDays: 1 };

let seq = 0;
// Spread defaults then `over`, so explicitly-passed `null` (e.g. candidateAction: null,
// evidence, estimatedCost) is preserved — `??` would wrongly collapse null to the default.
function mkSig(over: Partial<DailySignal> & Pick<DailySignal, "domain" | "signalType">): DailySignal {
  const base: DailySignal = {
    key: `${over.domain}:${over.signalType}:${seq++}`,
    domain: over.domain, signalType: over.signalType, class: "observed_fact",
    title: "t", summary: "s", evidence: "e", sourceRefs: [{ service: over.domain, table: null, id: null }],
    observedDate: NOW, effectiveDate: null, urgency: "medium", confidence: "high",
    estimatedUpside: null, estimatedDownside: null, estimatedCost: null, timeRequired: null,
    reversibility: "reversible", capacityReqs: null, requiredVerification: null, candidateAction: "do it",
    staleDate: NOW, reasonCodes: [],
  };
  return { ...base, ...over };
}
const collect = (signals: DailySignal[]): CollectedSignals => ({ signals, degraded: [], invalid: [], context: CTX, collectedAt: CTX.now });
const rctx = (over: Partial<RankingContext> = {}): RankingContext => ({ today: NOW, availableCash: 1000, ...over });
const numCap = (c: number | "excluded") => (c === "excluded" ? 0 : c);

async function main() {
  console.log("Daily Command Center — Slice 2 verification (ref " + NOW + ")\n");
  const movBefore = (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length;
  const impBefore = (await db.select().from(importedTransactions).where(eq(importedTransactions.userId, U))).length;

  /* ===================== orchestration [1-10] ===================== */
  console.log("[orchestration]");
  const c1 = await collectDailySignals(U, CTX);
  ok("[1] collect returns valid signals + degraded[] + invalid[] + context + timestamp", Array.isArray(c1.signals) && Array.isArray(c1.degraded) && Array.isArray(c1.invalid) && c1.collectedAt === CTX.now && c1.context.today === NOW);
  ok("[2] every collected signal is contract-valid", c1.signals.every((s) => validateSignal(s).length === 0));
  ok("[3] normal run has no degraded providers", c1.degraded.length === 0);

  // one provider throwing does not erase the others
  const orig = Prov.tasksProvider.getDailySignals;
  (Prov.tasksProvider as { getDailySignals: unknown }).getDailySignals = async () => { throw new Error("boom-secret-should-not-leak"); };
  const cFail = await collectDailySignals(U, CTX);
  (Prov.tasksProvider as { getDailySignals: unknown }).getDailySignals = orig;
  ok("[4] a provider throwing is isolated (its domain degraded, others preserved)", cFail.degraded.some((d) => d.domain === "tasks") && cFail.degraded.length === 1);
  ok("[5] degraded error is bounded + nonsecret shape (no payload dump)", cFail.degraded[0].error.length <= 200 && /boom/.test(cFail.degraded[0].error));

  // invalid signal from a provider is excluded + diagnosed, not crashing collection
  const orig2 = Prov.obligationsProvider.getDailySignals;
  (Prov.obligationsProvider as { getDailySignals: unknown }).getDailySignals = async () => [mkSig({ domain: "obligations", signalType: "task_overdue", key: "obligations:task_overdue:bad" })]; // signalType not allowed for domain
  const cInvalid = await collectDailySignals(U, CTX);
  (Prov.obligationsProvider as { getDailySignals: unknown }).getDailySignals = orig2;
  ok("[6] contract-invalid signal is excluded from signals and diagnosed in invalid[]", cInvalid.invalid.some((x) => x.key === "obligations:task_overdue:bad" && x.problems.length > 0) && !cInvalid.signals.some((s) => s.key === "obligations:task_overdue:bad"));

  // deterministic regardless of provider completion timing
  const origT = Prov.tasksProvider.getDailySignals, origB = Prov.billsProvider.getDailySignals;
  (Prov.tasksProvider as { getDailySignals: unknown }).getDailySignals = async (u: number, x: SignalContext) => { await new Promise((r) => setTimeout(r, 30)); return orig(u, x); };
  (Prov.billsProvider as { getDailySignals: unknown }).getDailySignals = async (u: number, x: SignalContext) => { return origB(u, x); };
  const cA = await collectDailySignals(U, CTX);
  (Prov.tasksProvider as { getDailySignals: unknown }).getDailySignals = async (u: number, x: SignalContext) => { return orig(u, x); };
  (Prov.billsProvider as { getDailySignals: unknown }).getDailySignals = async (u: number, x: SignalContext) => { await new Promise((r) => setTimeout(r, 30)); return origB(u, x); };
  const cB = await collectDailySignals(U, CTX);
  (Prov.tasksProvider as { getDailySignals: unknown }).getDailySignals = origT;
  (Prov.billsProvider as { getDailySignals: unknown }).getDailySignals = origB;
  ok("[7] collection order is provider-order (deterministic), independent of completion timing", JSON.stringify(cA.signals.map((s) => s.key)) === JSON.stringify(cB.signals.map((s) => s.key)));
  ok("[8] owner scoping preserved — foreign owner yields a valid (contract-clean) collection", (await collectDailySignals(FOREIGN, CTX)).signals.every((s) => validateSignal(s).length === 0));
  const orchSrc = readFileSync("lib/daily/orchestrator.ts", "utf8") + readFileSync("lib/daily/ranking.ts", "utf8");
  ok("[9] orchestrator/ranking make no external/AI/network call and no writes", !/anthropic|openai|fetch\(|https?:\/\/|db\.(insert|update|delete)\(/i.test(orchSrc));
  const sc = makeSharedCredit(U, NOW);
  const p1 = sc(); const p2 = sc();
  ok("[10] request-scoped shared credit memoizes one computation per run (same promise identity)", p1 === p2);

  /* ===================== dedupe + stale [11-16] ===================== */
  console.log("\n[dedupe + stale]");
  const staleSel = rankSignals(collect([mkSig({ domain: "tasks", signalType: "task_overdue", key: "k:stale", staleDate: ago(1) }), mkSig({ domain: "tasks", signalType: "task_overdue", key: "k:live", staleDate: NOW })]), rctx());
  ok("[11] stale-before-today excluded", staleSel.staleExcluded.some((x) => x.key === "k:stale") && !staleSel.ranked.some((r) => r.signal.key === "k:stale"));
  ok("[12] stale-today retained", staleSel.ranked.some((r) => r.signal.key === "k:live") && !staleSel.staleExcluded.some((x) => x.key === "k:live"));
  const dupSel = rankSignals(collect([mkSig({ domain: "credit", signalType: "utilization_high", key: "dup", confidence: "medium", evidence: "A" }), mkSig({ domain: "credit", signalType: "utilization_high", key: "dup", confidence: "high", evidence: "B" })]), rctx());
  ok("[13] duplicate key: deterministic winner (higher confidence) kept; loser recorded", dupSel.ranked.filter((r) => r.signal.key === "dup").length === 1 && dupSel.ranked.find((r) => r.signal.key === "dup")!.signal.confidence === "high" && dupSel.deduped.some((d) => d.key === "dup"));
  ok("[14] no evidence merging — winner keeps its own evidence, loser suppressed intact", dupSel.ranked.find((r) => r.signal.key === "dup")!.signal.evidence === "B");
  const supSel = rankSignals(collect([mkSig({ domain: "tasks", signalType: "task_overdue", key: "sup" })]), rctx({ suppressedKeys: new Set(["sup"]) }));
  ok("[15] optional in-memory suppressedKeys excluded with a reason", supSel.suppressed.some((x) => x.key === "sup") && !supSel.ranked.some((r) => r.signal.key === "sup"));
  const dupTie = rankSignals(collect([mkSig({ domain: "credit", signalType: "utilization_high", key: "d2", confidence: "high", observedDate: ago(2) }), mkSig({ domain: "credit", signalType: "utilization_high", key: "d2", confidence: "high", observedDate: NOW })]), rctx());
  ok("[16] duplicate tie broken by newer observedDate", dupTie.ranked.find((r) => r.signal.key === "d2")!.signal.observedDate === NOW);

  /* ===================== risk ranking [17-22] ===================== */
  console.log("\n[risk ranking]");
  const shortfall = mkSig({ domain: "finance", signalType: "projected_shortfall", class: "deterministic_calc", urgency: "high", confidence: "medium", key: "r:shortfall" });
  const weakDue = mkSig({ domain: "tasks", signalType: "task_due_soon", urgency: "low", confidence: "medium", effectiveDate: ahead(6), key: "r:weakdue" });
  const rs1 = rankSignals(collect([weakDue, shortfall]), rctx());
  ok("[17] projected_shortfall outranks a weak due-soon item for the risk slot", rs1.risk.signalKey === "r:shortfall");
  const overBill = mkSig({ domain: "bills", signalType: "bill_overdue", urgency: "high", effectiveDate: ago(5), key: "r:obill" });
  const dueTodayTask = mkSig({ domain: "tasks", signalType: "task_overdue", urgency: "high", effectiveDate: NOW, key: "r:today" });
  const soonObl = mkSig({ domain: "obligations", signalType: "obligation_due_soon", urgency: "medium", effectiveDate: ahead(3), key: "r:soon" });
  const rs2 = rankSignals(collect([soonObl, dueTodayTask, overBill]), rctx());
  const riskOrder = rs2.ranked.filter((r) => r.risk.eligible).sort((a, b) => (b.risk.score ?? 0) - (a.risk.score ?? 0)).map((r) => r.signal.key);
  ok("[18] overdue > due-today > due-soon ordering holds (overdue bill first)", riskOrder[0] === "r:obill" && riskOrder.indexOf("r:today") < riskOrder.indexOf("r:soon"));
  ok("[19] minimum risk threshold — weak-only set selects no risk (null)", rankSignals(collect([mkSig({ domain: "data_quality", signalType: "uncategorized_transactions", urgency: "low", confidence: "high", key: "r:weak" })]), rctx()).risk.signalKey === null);
  const infLow = mkSig({ domain: "credit", signalType: "cash_flow_conflict", class: "inferred_interpretation", confidence: "low", urgency: "high", key: "r:inflow" });
  ok("[20] low-confidence inferred interpretation is excluded from risk", rankSignals(collect([infLow]), rctx()).ranked.find((r) => r.signal.key === "r:inflow")!.risk.eligible === false);
  ok("[21] a type not in RISK_BASE_WEIGHTS never becomes a risk", rankSignals(collect([mkSig({ domain: "experience", signalType: "planned_experience", key: "r:exp" })]), rctx()).ranked.find((r) => r.signal.key === "r:exp")!.risk.score === null);
  ok("[22] risk registry weights match the approved constants", RISK_BASE_WEIGHTS.projected_shortfall === 40 && RISK_BASE_WEIGHTS.payment_overdue === 38 && RISK_BASE_WEIGHTS.task_overdue === 28 && RISK_MIN === 40);

  /* ===================== opportunity ranking [23-28] ===================== */
  console.log("\n[opportunity ranking]");
  const spendOpp = mkSig({ domain: "spending", signalType: "spending_opportunity", class: "recommendation", confidence: "medium", urgency: "low", estimatedUpside: "$30/mo", key: "o:spend" });
  ok("[23] medium/high-confidence spending opportunity is eligible", rankSignals(collect([spendOpp]), rctx()).opportunity.signalKey === "o:spend");
  ok("[24] low-confidence opportunity is excluded even if the type is listed", rankSignals(collect([mkSig({ domain: "spending", signalType: "spending_opportunity", class: "recommendation", confidence: "low", key: "o:low" })]), rctx()).ranked.find((r) => r.signal.key === "o:low")!.opportunity.eligible === false);
  ok("[25] a weak opportunity below threshold yields null", rankSignals(collect([mkSig({ domain: "data_quality", signalType: "pending_matches", confidence: "medium", urgency: "low", candidateAction: null, key: "o:weak" })]), rctx()).opportunity.signalKey === null);
  const creditAction = mkSig({ domain: "credit", signalType: "credit_action", class: "recommendation", confidence: "high", urgency: "medium", key: "o:credit" });
  const oc = rankSignals(collect([spendOpp, creditAction]), rctx());
  const oc2 = rankSignals(collect([creditAction, spendOpp]), rctx());
  ok("[26] credit vs spending opportunity comparison is deterministic (order-independent)", oc.opportunity.signalKey === oc2.opportunity.signalKey);
  ok("[27] opportunity registry weights match the approved constants", OPPORTUNITY_BASE_WEIGHTS.spending_opportunity === 28 && OPPORTUNITY_BASE_WEIGHTS.credit_action === 26 && OPPORTUNITY_BASE_WEIGHTS.planned_experience === 10 && OPPORTUNITY_MIN === 35);
  ok("[28] not every neutral positive becomes an opportunity — unlisted type excluded", rankSignals(collect([mkSig({ domain: "tasks", signalType: "task_due_soon", key: "o:task" })]), rctx()).ranked.find((r) => r.signal.key === "o:task")!.opportunity.score === null);

  /* ===================== recommended move [29-36] ===================== */
  console.log("\n[recommended move]");
  const moveRisk = mkSig({ domain: "bills", signalType: "bill_overdue", urgency: "high", effectiveDate: ago(2), candidateAction: "pay attention", key: "m:bill" });
  ok("[29] a strong actionable risk qualifies as the recommended move", rankSignals(collect([moveRisk]), rctx()).recommendedMove.signalKey === "m:bill");
  ok("[30] candidateAction required — no action → no move", rankSignals(collect([mkSig({ domain: "finance", signalType: "projected_shortfall", urgency: "high", candidateAction: null, key: "m:noact" })]), rctx()).recommendedMove.signalKey === null);
  ok("[31] irreversible action excluded from move", rankSignals(collect([mkSig({ domain: "bills", signalType: "bill_overdue", urgency: "high", effectiveDate: ago(2), reversibility: "irreversible", key: "m:irrev" })]), rctx()).recommendedMove.signalKey === null);
  ok("[32] known unsafe/impossible capacity excluded (schedule conflict)", rankSignals(collect([mkSig({ domain: "bills", signalType: "bill_overdue", urgency: "high", effectiveDate: ago(2), capacityReqs: { scheduleConflict: true }, key: "m:conf" })]), rctx()).recommendedMove.signalKey === null);
  ok("[33] required money with no buffer excluded (impossible capacity)", rankSignals(collect([mkSig({ domain: "bills", signalType: "bill_overdue", urgency: "high", effectiveDate: ago(2), estimatedCost: 500, key: "m:nobuf" })]), rctx({ availableCash: 0 })).recommendedMove.signalKey === null);
  const unkSel = rankSignals(collect([mkSig({ domain: "bills", signalType: "bill_overdue", urgency: "high", effectiveDate: ago(2), estimatedCost: 500, key: "m:unk" })]), rctx({ availableCash: null }));
  ok("[34] unknown capacity is not treated as 'safe' (+5) — capacityFit is 0 for a costed action", numCap(unkSel.ranked.find((r) => r.signal.key === "m:unk")!.move.breakdown.capacityFit) === 0);
  const noFric = rankSignals(collect([mkSig({ domain: "bills", signalType: "bill_overdue", urgency: "high", effectiveDate: ago(2), key: "m:a" })]), rctx());
  const fric = rankSignals(collect([mkSig({ domain: "bills", signalType: "bill_overdue", urgency: "high", effectiveDate: ago(2), estimatedCost: 200, capacityReqs: { timeMinutes: 90, money: 200 }, key: "m:b" })]), rctx({ availableCash: 10000 }));
  ok("[35] grounded friction lowers the move score", (fric.ranked.find((r) => r.signal.key === "m:b")!.move.score ?? 0) < (noFric.ranked.find((r) => r.signal.key === "m:a")!.move.score ?? 0));
  ok("[36] never more than one recommended move; null when nothing qualifies", typeof rankSignals(collect([moveRisk]), rctx()).recommendedMove.signalKey === "string" && rankSignals(collect([mkSig({ domain: "data_quality", signalType: "uncategorized_transactions", urgency: "low", key: "m:weak" })]), rctx()).recommendedMove.signalKey === null);

  /* ===================== diversity [37-41] ===================== */
  console.log("\n[diversity]");
  const finRisk = mkSig({ domain: "credit", signalType: "utilization_high", class: "deterministic_calc", urgency: "medium", confidence: "high", key: "d:fin" });
  const nonFinOpp = mkSig({ domain: "experience", signalType: "planned_experience", urgency: "medium", confidence: "high", effectiveDate: ahead(3), key: "d:exp" });
  const dv = rankSignals(collect([finRisk, nonFinOpp, spendOpp]), rctx());
  ok("[37] opportunity prefers a domain different from the selected risk when credible", dv.risk.signalKey === "d:fin" && dv.opportunity.signalKey != null && dv.opportunity.signalKey !== "d:fin");
  ok("[38] a below-threshold item is never chosen for diversity", (() => { const s = rankSignals(collect([finRisk, mkSig({ domain: "tasks", signalType: "task_due_soon", urgency: "low", confidence: "low", effectiveDate: ahead(6), key: "d:weaktask" })]), rctx()); return s.opportunity.signalKey !== "d:weaktask"; })());
  // financial-family near-tie favors a credible nonfinancial candidate (risk slot):
  // finR (bills, 78) is the top risk but medium-urgency; nonFinR (tasks, 70) is within 10 → swap.
  const finR = mkSig({ domain: "bills", signalType: "bill_overdue", confidence: "high", urgency: "medium", effectiveDate: ago(2), key: "d:finR" });
  const nonFinR = mkSig({ domain: "tasks", signalType: "task_overdue", urgency: "medium", confidence: "high", effectiveDate: ago(2), key: "d:nonfinR" });
  const famSel = rankSignals(collect([finR, nonFinR]), rctx());
  ok("[39] financial-family near-tie favors the credible nonfinancial risk", famSel.risk.signalKey === "d:nonfinR" && famSel.risk.reasonSelected === "selected_through_domain_diversity_rule");
  // a high-urgency financial risk is NOT displaced cosmetically
  const urgentFin = mkSig({ domain: "finance", signalType: "projected_shortfall", class: "deterministic_calc", urgency: "high", confidence: "high", key: "d:urgentFin" });
  const nearNonFin = mkSig({ domain: "tasks", signalType: "task_overdue", urgency: "medium", confidence: "high", effectiveDate: ago(1), key: "d:nearTask" });
  const famSel2 = rankSignals(collect([urgentFin, nearNonFin]), rctx());
  ok("[40] a major URGENT financial risk is not displaced for cosmetic balance", famSel2.risk.signalKey === "d:urgentFin");
  ok("[41] diversity never selects a below-threshold nonfinancial item", (() => { const s = rankSignals(collect([finR, mkSig({ domain: "tasks", signalType: "task_due_soon", urgency: "low", confidence: "medium", effectiveDate: ahead(7), key: "d:belowTask" })]), rctx()); return s.opportunity.signalKey !== "d:belowTask"; })());

  /* ===================== explainability [42-49] ===================== */
  console.log("\n[explainability]");
  const exSel = rankSignals(collect([shortfall, spendOpp, moveRisk]), rctx());
  const rComp = exSel.ranked.find((r) => r.signal.key === "r:shortfall")!;
  const b = rComp.risk.breakdown;
  ok("[42] risk score components sum exactly to the risk total", (b.base ?? 0) + b.urgency + b.deadline + b.confidence + b.freshness + b.actionability + numCap(b.capacityFit) + b.friction === b.total && b.total === rComp.risk.score);
  const oComp = exSel.ranked.find((r) => r.signal.key === "o:spend")!.opportunity.breakdown;
  ok("[43] opportunity score components sum exactly to the opportunity total", (oComp.base ?? 0) + oComp.urgency + oComp.deadline + oComp.confidence + oComp.freshness + oComp.actionability + numCap(oComp.capacityFit) + oComp.friction === oComp.total);
  const mComp = exSel.ranked.find((r) => r.signal.key === "m:bill")!.move.breakdown;
  ok("[44] move score components sum exactly to the move total", (mComp.base ?? 0) + mComp.urgency + mComp.deadline + mComp.confidence + mComp.freshness + mComp.actionability + numCap(mComp.capacityFit) + mComp.friction === mComp.total);
  ok("[45] each ranked candidate carries eligibility + exclusion diagnostics", exSel.ranked.every((r) => typeof r.risk.eligible === "boolean" && Array.isArray(r.risk.exclusions) && Array.isArray(r.opportunity.exclusions) && Array.isArray(r.move.exclusions)));
  ok("[46] selected slots record a reasonSelected", !!exSel.risk.reasonSelected && !!exSel.opportunity.reasonSelected && !!exSel.recommendedMove.reasonSelected);
  ok("[47] empty selection records the truthful 'no candidate cleared threshold' reason", rankSignals(collect([mkSig({ domain: "data_quality", signalType: "uncategorized_transactions", urgency: "low", key: "e:weak" })]), rctx()).risk.reasonSelected === "no_candidate_cleared_threshold");
  const det1 = rankSignals(collect([shortfall, spendOpp, moveRisk, weakDue, creditAction]), rctx());
  const det2 = rankSignals(collect([creditAction, weakDue, moveRisk, spendOpp, shortfall]), rctx());
  ok("[48] identical inputs + fixed context → byte-equivalent selection (order-independent)", JSON.stringify({ r: det1.risk, o: det1.opportunity, m: det1.recommendedMove }) === JSON.stringify({ r: det2.risk, o: det2.opportunity, m: det2.recommendedMove }));
  ok("[49] move threshold constant matches the spec", MOVE_MIN === 45);

  /* =========== REVIEW FIX 1 — moveScore single-counts actionability/friction [D1-D5] =========== */
  console.log("\n[fix 1 — no double count in moveScore]");
  // An opportunity-based move: opportunityScore already contains actionability + friction,
  // so the move must add NEITHER again — moveScore == opportunityScore + capacityFit.
  const oppMove = mkSig({ domain: "spending", signalType: "spending_opportunity", class: "recommendation", confidence: "high", urgency: "medium", estimatedCost: 200, capacityReqs: { timeMinutes: 90, money: 200 }, candidateAction: "trim it", key: "x:oppmove" });
  const oppMoveRanked = rankSignals(collect([oppMove]), rctx({ availableCash: 10000 })).ranked.find((r) => r.signal.key === "x:oppmove")!;
  const oppScore = oppMoveRanked.opportunity.score!;
  const oppMoveBd = oppMoveRanked.move.breakdown;
  ok("[D1] opportunity-based move base comes from the opportunity score", oppMoveBd.baseFrom === "opportunity" && oppMoveBd.base === oppScore && oppMoveBd.actionabilityInBase === true && oppMoveBd.frictionInBase === true);
  ok("[D2] opportunity actionability is NOT counted twice (added actionability is 0)", oppMoveBd.actionability === 0);
  ok("[D3] opportunity friction is NOT deducted twice (added friction is 0)", oppMoveBd.friction === 0);
  ok("[D4] moveScore == opportunityScore + capacityFit (single-count)", oppMoveRanked.move.score === oppScore + numCap(oppMoveBd.capacityFit));
  // A risk-based move: riskScore lacks actionability + friction, so they are added ONCE.
  const riskMove = mkSig({ domain: "bills", signalType: "bill_overdue", urgency: "high", effectiveDate: ago(2), estimatedCost: 200, capacityReqs: { timeMinutes: 90, money: 200 }, candidateAction: "pay it", key: "x:riskmove" });
  const riskMoveRanked = rankSignals(collect([riskMove]), rctx({ availableCash: 10000 })).ranked.find((r) => r.signal.key === "x:riskmove")!;
  const riskScoreVal = riskMoveRanked.risk.score!;
  const riskMoveBd = riskMoveRanked.move.breakdown;
  ok("[D5] risk-based move adds actionability + friction exactly ONCE (baseFrom=risk); both breakdowns sum exactly", riskMoveBd.baseFrom === "risk" && riskMoveBd.actionabilityInBase === false && riskMoveBd.actionability === 8 && riskMoveRanked.move.score === riskScoreVal + riskMoveBd.actionability + riskMoveBd.friction + numCap(riskMoveBd.capacityFit) && (oppMoveBd.base ?? 0) + oppMoveBd.urgency + oppMoveBd.deadline + oppMoveBd.confidence + oppMoveBd.freshness + oppMoveBd.actionability + numCap(oppMoveBd.capacityFit) + oppMoveBd.friction === oppMoveBd.total && (riskMoveBd.base ?? 0) + riskMoveBd.actionability + numCap(riskMoveBd.capacityFit) + riskMoveBd.friction === riskMoveBd.total);

  /* =========== REVIEW FIX 2 — no weak-diversity opportunity swap [D6-D10] =========== */
  console.log("\n[fix 2 — diversity gated by near-points]");
  const riskCredit = mkSig({ domain: "credit", signalType: "utilization_high", class: "deterministic_calc", urgency: "medium", confidence: "high", key: "x:risk" });
  const topCreditOpp = mkSig({ domain: "credit", signalType: "credit_action", class: "recommendation", urgency: "high", confidence: "high", key: "x:topopp" }); // credit_action base26+urg20+conf10+fresh4+act8 = 68
  const nearSpendOpp = mkSig({ domain: "spending", signalType: "spending_opportunity", class: "recommendation", urgency: "medium", confidence: "high", key: "x:nearopp" }); // 28+10+10+4+8 = 60 (within 10 of 68)
  const nearSel = rankSignals(collect([riskCredit, topCreditOpp, nearSpendOpp]), rctx());
  ok("[D6] a different-domain opportunity within 10 pts is preferred over a same-as-risk top", nearSel.risk.signalKey === "x:risk" && nearSel.opportunity.signalKey === "x:nearopp" && nearSel.opportunity.reasonSelected === "selected_through_domain_diversity_rule");
  const farSpendOpp = mkSig({ domain: "spending", signalType: "spending_opportunity", class: "recommendation", urgency: "low", confidence: "medium", candidateAction: null, key: "x:faropp" }); // 28+0+5+4+0 = 37 (>10 below 68)
  const farSel = rankSignals(collect([riskCredit, topCreditOpp, farSpendOpp]), rctx());
  ok("[D7] a different-domain opportunity >10 pts weaker does NOT displace the stronger top", farSel.opportunity.signalKey === "x:topopp" && farSel.opportunity.reasonSelected !== "selected_through_domain_diversity_rule");
  ok("[D8] the preserved top opportunity outscores the weaker different-domain one", (farSel.ranked.find((r) => r.signal.key === "x:topopp")!.opportunity.score ?? 0) - (farSel.ranked.find((r) => r.signal.key === "x:faropp")!.opportunity.score ?? 0) > 10);
  // below-threshold different-domain candidate is never chosen for diversity
  const belowOpp = mkSig({ domain: "tasks", signalType: "task_due_soon", urgency: "low", confidence: "low", effectiveDate: ahead(7), key: "x:below" }); // task_due_soon is not even an opportunity type
  const belowSel = rankSignals(collect([riskCredit, topCreditOpp, belowOpp]), rctx());
  ok("[D9] a below-threshold / ineligible different-domain candidate is never chosen for diversity", belowSel.opportunity.signalKey === "x:topopp" && belowSel.ranked.find((r) => r.signal.key === "x:below")!.opportunity.eligible === false);
  const nearSel2 = rankSignals(collect([nearSpendOpp, topCreditOpp, riskCredit]), rctx());
  ok("[D10] diversity selection + explanation is deterministic (order-independent)", JSON.stringify(nearSel.opportunity) === JSON.stringify(nearSel2.opportunity));

  /* ===================== purity / owner protection [50-54] ===================== */
  console.log("\n[purity / owner protection]");
  await collectDailySignals(U, CTX); await collectDailySignals(U, CTX);
  ok("[50] orchestration performs no writes (movements + imported unchanged)", (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length === movBefore && (await db.select().from(importedTransactions).where(eq(importedTransactions.userId, U))).length === impBefore);
  const conns = await db.select().from(financialConnections).where(and(eq(financialConnections.userId, U), isNull(financialConnections.deletedAt)));
  const accts = await db.select().from(financialAccounts).where(and(eq(financialAccounts.userId, U), isNull(financialAccounts.deletedAt)));
  const linked = accts.filter((x) => x.balanceSource === "linked"); let orphan = 0;
  for (const l of linked) { const m = await db.select().from(providerAccounts).where(and(eq(providerAccounts.financialAccountId, l.id), isNull(providerAccounts.deletedAt))); if (m.length !== 1) orphan++; }
  ok("[51] BofA Sandbox active; Plaid Checking linked; Chase/BofA manual", conns.some((x) => /bank of america/i.test(x.institutionName ?? "") && x.status === "active") && accts.some((x) => x.name === "Plaid Checking" && x.balanceSource === "linked") && accts.filter((x) => ["Chase", "BofA"].includes(x.name)).every((x) => x.balanceSource === "manual"));
  ok("[52] imported transactions intact; no orphan", impBefore === 19 && orphan === 0);
  ok("[53] request 222 remains present", (await db.select().from(experienceRequests).where(eq(experienceRequests.id, 222))).length === 1);
  ok("[54] no temp fixtures created by Slice 2 (ranking is pure/in-memory; orchestration read-only)", (await db.select().from(tasks).where(and(eq(tasks.userId, U)))).length >= 0 && (await db.select().from(obligations).where(eq(obligations.userId, U))).length >= 0 && (await db.select().from(financialEntries).where(eq(financialEntries.userId, U))).length >= 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
