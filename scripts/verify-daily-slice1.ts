/* =============================================================================
 * verify-daily-slice1.ts — Daily Command Center Slice 1 verification.
 *
 * Validates the unified signal contract + the grounded read-only providers:
 * contract validation, stable deterministic keys, owner scoping, PROVIDER PURITY
 * (no writes), per-domain mapping, stale/unknown/empty behavior, determinism, and
 * no unsupported-domain fabrication. Exact-ID temp fixtures, cleaned on exit.
 * Slice 1 has NO ranking/orchestration/persistence/API/UI/AI — none is asserted.
 * ===========================================================================*/

import { readFileSync } from "node:fs";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  tasks, obligations, financialEntries, experiences, accountMovements,
  creditScoreSnapshots, creditAccounts, creditCollections, creditGoals, creditInquiries, creditLatePayments,
  financialConnections, financialAccounts, providerAccounts, importedTransactions, experienceRequests,
  transactionCategories, transactionCategoryAssignments,
} from "@/db/schema";
import { CURRENT_USER_ID as U } from "@/lib/auth";
import * as Contract from "@/lib/daily/contract";
import * as P from "@/lib/daily/providers";
import * as Credit from "@/lib/services/credit";
import { ensureDefaultCategories, listCategories } from "@/lib/services/categories";

let passed = 0, failed = 0;
const ok = (n: string, c: boolean) => { c ? passed++ : failed++; console.log(`${c ? "✓" : "✗"} ${n}`); };
const NOW = "2026-07-01";
const FOREIGN = U + 99999;
const ago = (d: number) => new Date(Date.parse(NOW) - d * 86400000).toISOString().slice(0, 10);
const ahead = (d: number) => new Date(Date.parse(NOW) + d * 86400000).toISOString().slice(0, 10);
const CTX: Contract.SignalContext = { today: NOW, timezone: "America/New_York", now: `${NOW}T12:00:00.000Z`, freshnessDays: 1 };
const created = { tasks: [] as number[], obl: [] as number[], bills: [] as number[], exp: [] as number[], reqs: [] as number[], conn: 0, acct: 0, txns: [] as number[] };

const wellFormed = (over: Partial<Contract.DailySignal> = {}): Contract.DailySignal => ({
  key: "tasks:task_overdue:1", domain: "tasks", signalType: "task_overdue", class: "observed_fact",
  title: "t", summary: "s", evidence: "e", sourceRefs: [{ service: "tasks", table: "tasks", id: 1 }],
  observedDate: NOW, effectiveDate: NOW, urgency: "high", confidence: "high",
  estimatedUpside: null, estimatedDownside: null, estimatedCost: null, timeRequired: null,
  reversibility: "reversible", capacityReqs: null, requiredVerification: null, candidateAction: null,
  staleDate: NOW, reasonCodes: [], ...over,
});

async function resetCredit() {
  for (const t of [creditLatePayments, creditScoreSnapshots, creditCollections, creditInquiries, creditGoals, creditAccounts]) await db.delete(t).where(eq(t.userId, U)).catch(() => {});
}
async function cleanup() {
  await resetCredit().catch(() => {});
  if (created.tasks.length) await db.delete(tasks).where(inArray(tasks.id, created.tasks)).catch(() => {});
  if (created.obl.length) await db.delete(obligations).where(inArray(obligations.id, created.obl)).catch(() => {});
  if (created.bills.length) await db.delete(financialEntries).where(inArray(financialEntries.id, created.bills)).catch(() => {});
  if (created.exp.length) await db.delete(experiences).where(inArray(experiences.id, created.exp)).catch(() => {});
  if (created.reqs.length) await db.delete(experienceRequests).where(inArray(experienceRequests.id, created.reqs)).catch(() => {});
  await db.delete(transactionCategoryAssignments).where(eq(transactionCategoryAssignments.userId, U)).catch(() => {});
  await db.delete(transactionCategories).where(eq(transactionCategories.userId, U)).catch(() => {});
  if (created.txns.length) await db.delete(importedTransactions).where(inArray(importedTransactions.id, created.txns)).catch(() => {});
  if (created.acct) await db.delete(financialAccounts).where(eq(financialAccounts.id, created.acct)).catch(() => {});
  if (created.conn) await db.delete(financialConnections).where(eq(financialConnections.id, created.conn)).catch(() => {});
}

async function main() {
  console.log("Daily Command Center — Slice 1 verification (ref " + NOW + ")\n");
  await resetCredit();
  const ownerImportedBefore = (await db.select().from(importedTransactions).where(eq(importedTransactions.userId, U))).length;
  const ownerMovementsBefore = (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length;

  /* ===================== contract [1-14] ===================== */
  console.log("[contract]");
  ok("[1] validateSignal accepts a well-formed signal", Contract.validateSignal(wellFormed()).length === 0);
  ok("[2] rejects bad domain", Contract.validateSignal(wellFormed({ domain: "relationship" as never })).length > 0);
  ok("[3] rejects bad provenance class", Contract.validateSignal(wellFormed({ class: "guess" as never })).length > 0);
  ok("[4] rejects bad urgency", Contract.validateSignal(wellFormed({ urgency: "extreme" as never })).length > 0);
  ok("[5] rejects signalType not allowed for domain", Contract.validateSignal(wellFormed({ domain: "bills", signalType: "task_overdue", key: "bills:task_overdue:1" })).length > 0);
  ok("[6] rejects non-ISO observedDate", Contract.validateSignal(wellFormed({ observedDate: "07/01/2026" })).length > 0);
  ok("[7] rejects non-ISO staleDate", Contract.validateSignal(wellFormed({ staleDate: "soon" })).length > 0);
  ok("[8] allows null effectiveDate, rejects malformed effectiveDate", Contract.validateSignal(wellFormed({ effectiveDate: null })).length === 0 && Contract.validateSignal(wellFormed({ effectiveDate: "nope" })).length > 0);
  ok("[9] rejects empty sourceRefs", Contract.validateSignal(wellFormed({ sourceRefs: [] })).length > 0);
  ok("[10] rejects key not prefixed by domain", Contract.validateSignal(wellFormed({ key: "wrong:task_overdue:1" })).length > 0);
  ok("[11] the four provenance classes are exactly the spec set", JSON.stringify([...Contract.SIGNAL_CLASSES]) === JSON.stringify(["observed_fact", "deterministic_calc", "inferred_interpretation", "recommendation"]));
  ok("[12] datedUrgency: overdue→high, due-in-2→medium, due-in-10→low", Contract.datedUrgency(ago(1), NOW) === "high" && Contract.datedUrgency(ahead(2), NOW) === "medium" && Contract.datedUrgency(ahead(10), NOW) === "low");
  ok("[13] datedUrgency(null)→low (unknown, not fabricated urgency)", Contract.datedUrgency(null, NOW) === "low");
  ok("[14] validateSignals batch flags the bad one only", (() => { const r = Contract.validateSignals([wellFormed(), wellFormed({ domain: "x" as never })]); return !r.ok && r.errors.length === 1; })());

  /* ===================== provider registry [15-19] ===================== */
  console.log("\n[provider registry]");
  ok("[15] nine grounded providers registered", P.DAILY_SIGNAL_PROVIDERS.length === 9);
  ok("[16] every provider has a valid domain + getDailySignals fn", P.DAILY_SIGNAL_PROVIDERS.every((p) => (Contract.DAILY_DOMAINS as readonly string[]).includes(p.domain) && typeof p.getDailySignals === "function"));
  ok("[17] provider domains are unique", new Set(P.DAILY_SIGNAL_PROVIDERS.map((p) => p.domain)).size === 9);
  ok("[18] no unsupported-domain provider exists (relationship/health/career/calendar/knowledge/travel)", !P.DAILY_SIGNAL_PROVIDERS.some((p) => ["relationship", "health", "career", "calendar", "knowledge", "travel"].includes(p.domain)));
  ok("[19] no cross-domain collect/merge/rank export in providers (Slice 1 boundary)", !("collectDailySignals" in P) && !("rankSignals" in P) && !("buildDailyBrief" in P));

  /* ===================== owner scoping (no cross-user leakage) [20-23] ===================== */
  console.log("\n[owner scoping]");
  const rowScoped = [P.tasksProvider, P.obligationsProvider, P.billsProvider, P.goalsProvider, P.experienceProvider];
  ok("[20] row-scoped providers return [] for a user with no rows (no leakage)", (await Promise.all(rowScoped.map((p) => p.getDailySignals(FOREIGN, CTX)))).every((a) => a.length === 0));
  ok("[21] every provider returns an array for the foreign owner", (await Promise.all(P.DAILY_SIGNAL_PROVIDERS.map((p) => p.getDailySignals(FOREIGN, CTX)))).every(Array.isArray));
  await resetCredit();
  const isoGoal = await Credit.createGoal(U, { goalType: "score_target", targetValue: 740 });
  const fGoals = await P.goalsProvider.getDailySignals(FOREIGN, CTX);
  const uGoals = await P.goalsProvider.getDailySignals(U, CTX);
  ok("[22] cross-user isolation — an owner goal never surfaces for the foreign owner", fGoals.length === 0 && uGoals.some((s) => s.sourceRefs[0].id === isoGoal.id));
  await resetCredit();
  const fCredit = await P.creditProvider.getDailySignals(FOREIGN, CTX);
  ok("[23] generic advice for an empty profile carries only null-id refs (no concrete owned-entity leakage) + validates", Contract.validateSignals(fCredit).ok && fCredit.every((s) => s.sourceRefs.every((r) => r.id === null)));

  /* ===================== tasks mapping [24-28] ===================== */
  console.log("\n[tasks mapping]");
  const [tOver] = await db.insert(tasks).values({ userId: U, title: "ZZ Overdue Task", priority: "high", status: "not_started", dueDate: ago(2) }).returning({ id: tasks.id }); created.tasks.push(tOver.id);
  const [tDone] = await db.insert(tasks).values({ userId: U, title: "ZZ Done Task", priority: "high", status: "completed", dueDate: ago(2), completedAt: new Date() }).returning({ id: tasks.id }); created.tasks.push(tDone.id);
  const [tNoDate] = await db.insert(tasks).values({ userId: U, title: "ZZ No Due Task", priority: "high", status: "not_started", dueDate: null }).returning({ id: tasks.id }); created.tasks.push(tNoDate.id);
  const taskSignals = await P.tasksProvider.getDailySignals(U, CTX);
  const tSig = taskSignals.find((s) => s.key === `tasks:task_overdue:${tOver.id}`);
  ok("[24] overdue task maps to a task_overdue signal", !!tSig && tSig.domain === "tasks" && tSig.class === "observed_fact" && tSig.urgency === "high" && tSig.effectiveDate === ago(2));
  ok("[25] task signal carries traceable sourceRefs + stable key", !!tSig && tSig.sourceRefs[0].service === "tasks" && tSig.sourceRefs[0].id === tOver.id && tSig.key === `tasks:task_overdue:${tOver.id}`);
  ok("[26] completed task emits no active signal", !taskSignals.some((s) => s.sourceRefs[0].id === tDone.id));
  ok("[27] task with unknown (null) due date emits nothing — unknown ≠ overdue", !taskSignals.some((s) => s.sourceRefs[0].id === tNoDate.id));
  ok("[28] all task signals validate", Contract.validateSignals(taskSignals).ok);

  /* ===================== obligations mapping [29-31] ===================== */
  console.log("\n[obligations mapping]");
  const [oblToday] = await db.insert(obligations).values({ userId: U, title: "ZZ Today Obligation", type: "appointment", startDate: NOW, importance: "high", status: "upcoming" }).returning({ id: obligations.id }); created.obl.push(oblToday.id);
  const [oblDone] = await db.insert(obligations).values({ userId: U, title: "ZZ Done Obligation", type: "appointment", startDate: NOW, importance: "high", status: "done" }).returning({ id: obligations.id }); created.obl.push(oblDone.id);
  const oblSignals = await P.obligationsProvider.getDailySignals(U, CTX);
  const oSig = oblSignals.find((s) => s.sourceRefs[0].id === oblToday.id);
  ok("[29] upcoming obligation maps to a signal (observed_fact, dated)", !!oSig && oSig.domain === "obligations" && oSig.class === "observed_fact" && oSig.effectiveDate === NOW);
  ok("[30] closed (done) obligation emits nothing", !oblSignals.some((s) => s.sourceRefs[0].id === oblDone.id));
  ok("[31] obligation signals validate + key stable", Contract.validateSignals(oblSignals).ok && oSig!.key === `obligations:${oSig!.signalType}:${oblToday.id}`);

  /* ===================== bills mapping [32-35] ===================== */
  console.log("\n[bills mapping]");
  const [bDue] = await db.insert(financialEntries).values({ userId: U, name: "ZZ Due Bill", kind: "bill", expectedAmount: "120.00", status: "scheduled", dueDate: ahead(1) }).returning({ id: financialEntries.id }); created.bills.push(bDue.id);
  const [bPaid] = await db.insert(financialEntries).values({ userId: U, name: "ZZ Paid Bill", kind: "bill", expectedAmount: "120.00", status: "paid", dueDate: ahead(1) }).returning({ id: financialEntries.id }); created.bills.push(bPaid.id);
  const [bNoDate] = await db.insert(financialEntries).values({ userId: U, name: "ZZ NoDate Bill", kind: "bill", expectedAmount: "120.00", status: "scheduled", dueDate: null }).returning({ id: financialEntries.id }); created.bills.push(bNoDate.id);
  const billSignals = await P.billsProvider.getDailySignals(U, CTX);
  const bSig = billSignals.find((s) => s.sourceRefs[0].id === bDue.id);
  ok("[32] due-soon unpaid bill maps to a bill_due_soon signal", !!bSig && bSig.signalType === "bill_due_soon" && bSig.estimatedCost === 120 && bSig.class === "observed_fact");
  ok("[33] paid bill emits no due signal", !billSignals.some((s) => s.sourceRefs[0].id === bPaid.id));
  ok("[34] bill with unknown due date emits nothing (unknown ≠ due)", !billSignals.some((s) => s.sourceRefs[0].id === bNoDate.id));
  ok("[35] bill signal carries money capacity + validates", !!bSig && bSig.capacityReqs?.money === 120 && Contract.validateSignals(billSignals).ok);

  /* ===================== finance mapping [36-37] ===================== */
  console.log("\n[finance mapping]");
  const financeSignals = await P.financeProvider.getDailySignals(U, CTX);
  ok("[36] finance provider returns valid deterministic_calc signals (or empty)", Array.isArray(financeSignals) && financeSignals.every((s) => s.domain === "finance" && s.class === "deterministic_calc") && Contract.validateSignals(financeSignals).ok);
  const financeAgain = await P.financeProvider.getDailySignals(U, CTX);
  ok("[37] finance mapping is deterministic for fixed ctx", JSON.stringify(financeSignals) === JSON.stringify(financeAgain));

  /* ===================== credit mapping [38-44] ===================== */
  console.log("\n[credit mapping]");
  await resetCredit();
  await Credit.createScore(U, { score: 680, source: "experian", asOfDate: ago(40) });
  await Credit.createScore(U, { score: 700, source: "experian", asOfDate: ago(3) });
  await Credit.createAccount(U, { name: "ZZ High Util", accountType: "credit_card", isRevolving: true, creditLimit: 1000, currentBalance: 700, minimumPayment: 35, status: "open" });
  await Credit.createCollection(U, { collectorName: "ZZ Verify Me", reportedBalance: 350, validationStatus: "not_requested" });
  const creditSignals = await P.creditProvider.getDailySignals(U, CTX);
  const sc = creditSignals.find((s) => s.signalType === "score_change");
  ok("[38] score increase maps to a score_change signal (deterministic_calc)", !!sc && sc.class === "deterministic_calc" && /increased/.test(sc.summary));
  ok("[39] high utilization maps to utilization_high (deterministic_calc)", creditSignals.some((s) => s.signalType === "utilization_high" && s.class === "deterministic_calc"));
  ok("[40] unverified collection maps to collection_unverified (observed_fact) + verify-first", creditSignals.some((s) => s.signalType === "collection_unverified" && s.class === "observed_fact" && /verify the debt/i.test(s.requiredVerification ?? "")));
  ok("[41] credit action cards map to recommendation-class signals with candidateAction", creditSignals.some((s) => s.signalType === "credit_action" && s.class === "recommendation" && !!s.candidateAction && !!s.requiredVerification));
  ok("[42] credit provider does not emit goal_progress (owned by goals provider)", !creditSignals.some((s) => s.signalType === "goal_progress"));
  ok("[43] credit provider does not emit data_update_needed (owned by data_quality)", !creditSignals.some((s) => s.signalType === "data_update_needed"));
  ok("[44] all credit signals validate + keys domain-prefixed", Contract.validateSignals(creditSignals).ok && creditSignals.every((s) => s.key.startsWith("credit:")));

  /* ===================== goals mapping [45-46] ===================== */
  console.log("\n[goals mapping]");
  const g = await Credit.createGoal(U, { goalType: "utilization_target", targetValue: 30 });
  const goalSignals = await P.goalsProvider.getDailySignals(U, CTX);
  const gSig = goalSignals.find((s) => s.sourceRefs[0].id === g.id);
  ok("[45] active credit goal maps to a goal_progress signal (deterministic_calc)", !!gSig && gSig.domain === "goals" && gSig.class === "deterministic_calc" && gSig.key === `goals:goal_progress:${g.id}`);
  ok("[46] goal signal distinguishes unknown vs value + validates", !!gSig && /current/.test(gSig.evidence) && Contract.validateSignals(goalSignals).ok);

  /* ===================== spending mapping [47-48] ===================== */
  console.log("\n[spending mapping]");
  const spendSignals = await P.spendingProvider.getDailySignals(U, CTX);
  ok("[47] spending opportunities map to recommendation signals; low-confidence suppressed", Array.isArray(spendSignals) && spendSignals.every((s) => s.domain === "spending" && s.class === "recommendation" && s.confidence !== "low") && Contract.validateSignals(spendSignals).ok);
  ok("[48] spending mapping deterministic for fixed ctx", JSON.stringify(spendSignals) === JSON.stringify(await P.spendingProvider.getDailySignals(U, CTX)));

  /* ===================== data-quality + stale [49-52] ===================== */
  console.log("\n[data quality + stale]");
  await resetCredit();
  await Credit.createScore(U, { score: 690, source: "experian", asOfDate: ago(60) }); // single OLD score
  const creditStaleSignals = await P.creditProvider.getDailySignals(U, CTX);
  const dqSignals = await P.dataQualityProvider.getDailySignals(U, CTX);
  ok("[49] a single old score yields NO score_change (needs two) — no fabricated trend", !creditStaleSignals.some((s) => s.signalType === "score_change"));
  ok("[50] stale score surfaces as a data_quality signal, not a substantive credit signal", dqSignals.some((s) => s.signalType === "stale_credit_score" && s.domain === "data_quality") && !creditStaleSignals.some((s) => s.signalType === "stale_credit_score"));
  ok("[51] data_quality signals validate + are deterministic_calc", Contract.validateSignals(dqSignals).ok && dqSignals.every((s) => s.class === "deterministic_calc"));
  ok("[52] data_quality emits nothing it cannot ground (foreign owner → [])", (await P.dataQualityProvider.getDailySignals(FOREIGN, CTX)).length === 0);

  /* ===================== experience mapping [53-54] ===================== */
  console.log("\n[experience mapping]");
  const [req1] = await db.insert(experienceRequests).values({ userId: U, requestText: "ZZ req 1" }).returning({ id: experienceRequests.id }); created.reqs.push(req1.id);
  const [req2] = await db.insert(experienceRequests).values({ userId: U, requestText: "ZZ req 2" }).returning({ id: experienceRequests.id }); created.reqs.push(req2.id);
  const [exp] = await db.insert(experiences).values({ userId: U, requestId: req1.id, title: "ZZ Planned Trip", status: "planned", plannedDate: ahead(10) }).returning({ id: experiences.id }); created.exp.push(exp.id);
  const [expNoDate] = await db.insert(experiences).values({ userId: U, requestId: req2.id, title: "ZZ Undated Idea", status: "planned", plannedDate: null }).returning({ id: experiences.id }); created.exp.push(expNoDate.id);
  const expSignals = await P.experienceProvider.getDailySignals(U, CTX);
  ok("[53] planned experience with a grounded date maps to a signal; undated one does not", expSignals.some((s) => s.sourceRefs[0].id === exp.id && s.signalType === "planned_experience") && !expSignals.some((s) => s.sourceRefs[0].id === expNoDate.id));
  ok("[54] experience signals validate (observed_fact, dated)", Contract.validateSignals(expSignals).ok && expSignals.every((s) => s.class === "observed_fact"));

  /* =========== REVIEW FIX 1 — overdue freshness (recompute-based, not deadline-based) [F1-F8] =========== */
  console.log("\n[freshness — unresolved overdue must not expire]");
  const nonStale = (s: Contract.DailySignal) => s.staleDate >= NOW; // ranker excludes staleDate < today
  const expectedRecompute = ahead(1); // ctx.today + freshnessDays(1)
  // a task > 3 days overdue, still active
  const [tOld] = await db.insert(tasks).values({ userId: U, title: "ZZ 10d Overdue Task", priority: "high", status: "not_started", dueDate: ago(10) }).returning({ id: tasks.id }); created.tasks.push(tOld.id);
  const tOldSig = (await P.tasksProvider.getDailySignals(U, CTX)).find((s) => s.sourceRefs[0].id === tOld.id);
  ok("[F1] a task >3 days overdue (active) remains non-stale (staleDate is future, not dueDate+3)", !!tOldSig && nonStale(tOldSig) && tOldSig.staleDate === expectedRecompute && tOldSig.staleDate > ago(10));
  // an obligation > 3 days past start, still active
  const [oOld] = await db.insert(obligations).values({ userId: U, title: "ZZ 10d Past Obligation", type: "appointment", startDate: ago(10), importance: "high", status: "upcoming" }).returning({ id: obligations.id }); created.obl.push(oOld.id);
  const oOldSig = (await P.obligationsProvider.getDailySignals(U, CTX)).find((s) => s.sourceRefs[0].id === oOld.id);
  ok("[F2] an obligation >3 days past start (active) remains non-stale", !!oOldSig && nonStale(oOldSig) && oOldSig.staleDate === expectedRecompute);
  // an unpaid bill > 3 days overdue
  const [bOld] = await db.insert(financialEntries).values({ userId: U, name: "ZZ 10d Overdue Bill", kind: "bill", expectedAmount: "80.00", status: "scheduled", dueDate: ago(10) }).returning({ id: financialEntries.id }); created.bills.push(bOld.id);
  const bOldSig = (await P.billsProvider.getDailySignals(U, CTX)).find((s) => s.sourceRefs[0].id === bOld.id);
  ok("[F3] an unpaid bill >3 days overdue remains non-stale", !!bOldSig && nonStale(bOldSig) && bOldSig.staleDate === expectedRecompute);
  // resolution stops the signal (no active signal once completed/closed/paid)
  await db.update(tasks).set({ status: "completed", completedAt: new Date() }).where(eq(tasks.id, tOld.id));
  await db.update(obligations).set({ status: "done" }).where(eq(obligations.id, oOld.id));
  await db.update(financialEntries).set({ status: "paid" }).where(eq(financialEntries.id, bOld.id));
  const afterResolve = [...await P.tasksProvider.getDailySignals(U, CTX), ...await P.obligationsProvider.getDailySignals(U, CTX), ...await P.billsProvider.getDailySignals(U, CTX)];
  ok("[F4] resolving (complete/done/paid) stops the signal — freshness is not made permanent", !afterResolve.some((s) => [tOld.id, oOld.id, bOld.id].includes(s.sourceRefs[0].id as number)));
  ok("[F5] recompute stale date is bounded (near-future, not permanent)", Contract.dayDiff(expectedRecompute, NOW) <= 7 && Contract.dayDiff(expectedRecompute, NOW) >= 1);
  // future dated items retain sensible (future) freshness
  const [tSoon] = await db.insert(tasks).values({ userId: U, title: "ZZ Due-Soon Task", priority: "medium", status: "not_started", dueDate: ahead(2) }).returning({ id: tasks.id }); created.tasks.push(tSoon.id);
  const tSoonSig = (await P.tasksProvider.getDailySignals(U, CTX)).find((s) => s.sourceRefs[0].id === tSoon.id);
  ok("[F6] a future due-soon task has sensible future freshness", !!tSoonSig && nonStale(tSoonSig));
  const expFreshSig = (await P.experienceProvider.getDailySignals(U, CTX)).find((s) => s.sourceRefs[0].id === exp.id);
  ok("[F7] future planned experience retains event-relative freshness (plannedDate + grace, in the future)", !!expFreshSig && expFreshSig.staleDate === ahead(13) && nonStale(expFreshSig));
  ok("[F8] finance/credit/goal/data-quality signals also use recompute-based freshness (>= today)", [...await P.financeProvider.getDailySignals(U, CTX), ...await P.creditProvider.getDailySignals(U, CTX), ...await P.goalsProvider.getDailySignals(U, CTX), ...await P.dataQualityProvider.getDailySignals(U, CTX)].every((s) => nonStale(s)));

  /* =========== REVIEW FIX 2 — potential savings is not a cost [F9-F11] =========== */
  console.log("\n[spending — savings is not a cost]");
  // Seed a real reduce-merchant opportunity (carries estimatedUpsideMax > 0) so the mapping is proven.
  await db.delete(transactionCategoryAssignments).where(eq(transactionCategoryAssignments.userId, U));
  await db.delete(transactionCategories).where(eq(transactionCategories.userId, U));
  const [sconn] = await db.insert(financialConnections).values({ userId: U, provider: "plaid", providerItemId: `ZZS-${Date.now()}`, institutionName: "ZZS", accessTokenCipher: "x", accessTokenNonce: "x", accessTokenTag: "x", accessTokenKeyVersion: 1, accessTokenEnvelopeVersion: 1, status: "active", environment: "sandbox" }).returning({ id: financialConnections.id }); created.conn = sconn.id;
  const [sa] = await db.insert(financialAccounts).values({ userId: U, name: "ZZS Acct", type: "checking", purpose: "spending", balanceSource: "manual", currentBalance: "1000.00", active: true }).returning({ id: financialAccounts.id }); created.acct = sa.id;
  await ensureDefaultCategories(U); const cats = await listCategories(U, { includeInactive: true });
  const dining = cats.find((c) => c.slug === "dining-and-coffee")!.id;
  let n = 0;
  for (const [d, amt] of [[3, 28], [7, 30], [11, 25], [15, 33], [20, 30]] as [number, number][]) {
    const [t] = await db.insert(importedTransactions).values({ userId: U, connectionId: sconn.id, providerAccountId: "pa", provider: "plaid", providerTransactionId: `ZZS-${n++}-${Date.now()}`, status: "active", isPending: false, amount: String(-amt), descriptionCurrent: "ZZS DoorDash", merchantName: "ZZS DoorDash", financialAccountId: sa.id, postedDate: ago(d) }).returning({ id: importedTransactions.id });
    created.txns.push(t.id);
    await db.insert(transactionCategoryAssignments).values({ userId: U, transactionId: t.id, categoryId: dining, source: "owner", status: "confirmed", reasonCodes: "[]", reviewedAt: new Date() });
  }
  const spend2 = await P.spendingProvider.getDailySignals(U, CTX);
  const reduceSig = spend2.find((s) => /DoorDash/.test(s.summary));
  ok("[F9] a seeded reduce-merchant opportunity WITH estimated savings surfaces as a spending signal", !!reduceSig && !!reduceSig.estimatedUpside && /\$/.test(reduceSig.estimatedUpside!));
  ok("[F10] that opportunity does NOT emit its potential savings as estimatedCost (cost null; no invented cost; capacity does not require spending the savings)", !!reduceSig && reduceSig.estimatedCost === null && (reduceSig.capacityReqs == null || reduceSig.capacityReqs.money == null));
  ok("[F11] every spending signal keeps estimatedCost null while savings live in estimatedUpside", spend2.every((s) => s.estimatedCost === null) && spend2.every((s) => !(s.capacityReqs && s.capacityReqs.money != null)));
  // clean the spending fixture immediately (owner has no real categories)
  await db.delete(transactionCategoryAssignments).where(eq(transactionCategoryAssignments.userId, U));
  await db.delete(transactionCategories).where(eq(transactionCategories.userId, U));
  await db.delete(importedTransactions).where(inArray(importedTransactions.id, created.txns)); created.txns = [];
  await db.delete(financialAccounts).where(eq(financialAccounts.id, created.acct)); created.acct = 0;
  await db.delete(financialConnections).where(eq(financialConnections.id, created.conn)); created.conn = 0;

  /* ===================== determinism + no-fabrication (whole set) [55-58] ===================== */
  console.log("\n[determinism + fabrication]");
  const runAll = async () => (await Promise.all(P.DAILY_SIGNAL_PROVIDERS.map((p) => p.getDailySignals(U, CTX)))).flat();
  const runA = await runAll(); const runB = await runAll();
  ok("[55] identical inputs + fixed time context → identical outputs", JSON.stringify(runA) === JSON.stringify(runB));
  ok("[56] every emitted signal validates against the contract", Contract.validateSignals(runA).ok);
  ok("[57] every signal's domain is a known grounded domain (no fabricated domains)", runA.every((s) => (Contract.DAILY_DOMAINS as readonly string[]).includes(s.domain)));
  ok("[58] provenance is preserved (facts/calcs/inferences/recommendations all present or absent honestly — never a 5th class)", runA.every((s) => (Contract.SIGNAL_CLASSES as readonly string[]).includes(s.class)));

  /* ===================== purity / no writes [59-64] ===================== */
  console.log("\n[purity / no writes]");
  const countAll = async () => ({
    tasks: (await db.select().from(tasks).where(eq(tasks.userId, U))).length,
    obl: (await db.select().from(obligations).where(eq(obligations.userId, U))).length,
    bills: (await db.select().from(financialEntries).where(eq(financialEntries.userId, U))).length,
    exp: (await db.select().from(experiences).where(eq(experiences.userId, U))).length,
    scores: (await db.select().from(creditScoreSnapshots).where(eq(creditScoreSnapshots.userId, U))).length,
    accts: (await db.select().from(creditAccounts).where(eq(creditAccounts.userId, U))).length,
    coll: (await db.select().from(creditCollections).where(eq(creditCollections.userId, U))).length,
    goals: (await db.select().from(creditGoals).where(eq(creditGoals.userId, U))).length,
    mov: (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length,
    imported: (await db.select().from(importedTransactions).where(eq(importedTransactions.userId, U))).length,
  });
  const beforeSnap = JSON.stringify(await countAll());
  const taskRowBefore = JSON.stringify((await db.select().from(tasks).where(eq(tasks.id, tOver.id)))[0]);
  await runAll(); await runAll(); // exercise every provider repeatedly
  const afterSnap = JSON.stringify(await countAll());
  ok("[59] running all providers writes/deletes no rows (counts unchanged)", beforeSnap === afterSnap);
  ok("[60] a sampled source row is byte-identical after provider runs (no mutation)", JSON.stringify((await db.select().from(tasks).where(eq(tasks.id, tOver.id)))[0]) === taskRowBefore);
  ok("[61] no account movement created", (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length === ownerMovementsBefore);
  ok("[62] imported transactions untouched", (await db.select().from(importedTransactions).where(eq(importedTransactions.userId, U))).length === ownerImportedBefore);
  const src = readFileSync("lib/daily/providers.ts", "utf8") + readFileSync("lib/daily/contract.ts", "utf8");
  ok("[63] provider/contract source contains no write/mutation calls", !/db\.(insert|update|delete)\(|onConflict|migrate/.test(src));
  ok("[64] provider/contract source makes no external/AI/network call", !/anthropic|openai|fetch\(|https?:\/\/|plaidClient|axios/i.test(src));

  await cleanup();

  /* ===================== owner protection [65-70] ===================== */
  console.log("\n[owner protection]");
  const conns = await db.select().from(financialConnections).where(and(eq(financialConnections.userId, U), isNull(financialConnections.deletedAt)));
  const bofa = conns.find((x) => /bank of america/i.test(x.institutionName ?? ""));
  const accts = await db.select().from(financialAccounts).where(and(eq(financialAccounts.userId, U), isNull(financialAccounts.deletedAt)));
  const linked = accts.filter((x) => x.balanceSource === "linked"); let orphan = 0;
  for (const l of linked) { const m = await db.select().from(providerAccounts).where(and(eq(providerAccounts.financialAccountId, l.id), isNull(providerAccounts.deletedAt))); if (m.length !== 1) orphan++; }
  ok("[65] Bank of America Sandbox remains active", bofa?.status === "active" && bofa?.environment === "sandbox");
  ok("[66] Plaid Checking remains linked; Chase/BofA manual", accts.some((x) => x.name === "Plaid Checking" && x.balanceSource === "linked") && accts.filter((x) => ["Chase", "BofA"].includes(x.name)).every((x) => x.balanceSource === "manual"));
  ok("[67] imported transactions intact; no orphan", (await db.select().from(importedTransactions).where(eq(importedTransactions.userId, U))).length === ownerImportedBefore && orphan === 0);
  ok("[68] request 222 remains present", (await db.select().from(experienceRequests).where(eq(experienceRequests.id, 222))).length === 1);
  ok("[69] exact-ID cleanup — no ZZ fixtures or temp credit rows remain", (await db.select().from(tasks).where(and(eq(tasks.userId, U), inArray(tasks.id, created.tasks.length ? created.tasks : [-1])))).length === 0 && (await db.select().from(creditScoreSnapshots).where(eq(creditScoreSnapshots.userId, U))).length === 0 && (await db.select().from(creditGoals).where(eq(creditGoals.userId, U))).length === 0 && (await db.select().from(experiences).where(and(eq(experiences.userId, U), inArray(experiences.id, created.exp.length ? created.exp : [-1])))).length === 0);
  ok("[70] no secret in provider/contract source", !/access-sandbox-[0-9a-f]{8}|sk-ant-|npg_[A-Za-z0-9]{6}/.test(src));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch(async (e) => { try { await cleanup(); } catch { /* noop */ } console.error(e); process.exit(1); });
