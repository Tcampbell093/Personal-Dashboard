/* =============================================================================
 * verify-daily-slice4.ts — Daily Command Center Slice 4 verification.
 *
 * Secure read/present/respond/outcome APIs + public view-model. Exercises the real
 * route handlers (invoked directly), the public view-model, and the lifecycle
 * idempotency/outcome service. Server-derived ownership; no consequential action;
 * GET is read-only. Exact-ID / prefixed fixtures + a temp secondary user, cleaned.
 * ===========================================================================*/

import { readFileSync } from "node:fs";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { dailyRecommendations, tasks, users, financialConnections, financialAccounts, providerAccounts, importedTransactions, experienceRequests } from "@/db/schema";
import { CURRENT_USER_ID as U } from "@/lib/auth";
import { localToday } from "@/lib/time";
import { isStrictISODate, type DailySignal, type SignalContext } from "@/lib/daily/contract";
import { fingerprintOfSignal } from "@/lib/daily/fingerprint";
import { rankSignals, type RankingContext } from "@/lib/daily/ranking";
import type { CollectedSignals } from "@/lib/daily/orchestrator";
import * as L from "@/lib/daily/lifecycle";
import { buildDailyBriefView, buildToday, capacityResult } from "@/lib/daily/view";
import { GET as dailyGET } from "@/app/api/daily/route";
import { POST as presentPOST } from "@/app/api/daily/recommendations/[key]/present/route";
import { POST as respondPOST } from "@/app/api/daily/recommendations/[key]/respond/route";
import { POST as outcomePOST } from "@/app/api/daily/recommendations/[key]/outcome/route";

let passed = 0, failed = 0;
const ok = (n: string, c: boolean) => { c ? passed++ : failed++; console.log(`${c ? "✓" : "✗"} ${n}`); };
const NOW = "2026-07-01"; const NOWD = new Date("2026-07-01T12:00:00.000Z");
const ago = (d: number) => new Date(Date.parse(NOW) - d * 86400000).toISOString().slice(0, 10);
const ahead = (d: number) => new Date(Date.parse(NOW) + d * 86400000).toISOString().slice(0, 10);
const CTX: SignalContext = { today: NOW, timezone: "America/New_York", now: `${NOW}T12:00:00.000Z`, freshnessDays: 1 };
const params = (key: string) => ({ params: Promise.resolve({ key: encodeURIComponent(key) }) });
const rawParams = (rawKey: string) => ({ params: Promise.resolve({ key: rawKey }) });
const jReq = (body: unknown) => new Request("http://t/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const jReqCT = (body: unknown, ct: string) => new Request("http://t/", { method: "POST", headers: { "content-type": ct }, body: JSON.stringify(body) });
const noCtReq = (body: unknown) => new Request("http://t/", { method: "POST", body: JSON.stringify(body) }); // no Content-Type header
const rawReq = (raw: string) => new Request("http://t/", { method: "POST", headers: { "content-type": "application/json" }, body: raw });
async function threw(fn: () => Promise<unknown>): Promise<boolean> { try { await fn(); return false; } catch (e) { return e instanceof L.LifecycleError; } }

let seq = 0;
function mkSig(over: Partial<DailySignal> & Pick<DailySignal, "domain" | "signalType">): DailySignal {
  const base: DailySignal = { key: `${over.domain}:${over.signalType}:${seq++}`, domain: over.domain, signalType: over.signalType, class: "observed_fact", title: "t", summary: "s", evidence: "e", sourceRefs: [{ service: over.domain, table: null, id: null }], observedDate: NOW, effectiveDate: null, urgency: "medium", confidence: "high", estimatedUpside: null, estimatedDownside: null, estimatedCost: null, timeRequired: null, reversibility: "reversible", capacityReqs: null, requiredVerification: null, candidateAction: "do it", staleDate: NOW, reasonCodes: [] };
  return { ...base, ...over };
}
const collect = (signals: DailySignal[]): CollectedSignals => ({ signals, degraded: [], invalid: [], context: CTX, collectedAt: CTX.now });
const rctx = (o: Partial<RankingContext> = {}): RankingContext => ({ today: NOW, availableCash: 1000, ...o });

const created = { tasks: [] as number[], otherUser: 0 };
async function resetLifecycleU() { await db.delete(dailyRecommendations).where(eq(dailyRecommendations.userId, U)).catch(() => {}); }
async function cleanup() {
  await resetLifecycleU();
  if (created.tasks.length) await db.delete(tasks).where(inArray(tasks.id, created.tasks)).catch(() => {});
  if (created.otherUser) { await db.delete(dailyRecommendations).where(eq(dailyRecommendations.userId, created.otherUser)).catch(() => {}); await db.delete(users).where(eq(users.id, created.otherUser)).catch(() => {}); }
}
const bodyOf = async (res: Response) => res.json() as Promise<Record<string, unknown>>;

async function main() {
  console.log("Daily Command Center — Slice 4 verification\n");
  await resetLifecycleU();
  const impBefore = (await db.select().from(importedTransactions).where(eq(importedTransactions.userId, U))).length;

  /* ===================== public view-model (pure) [1-14] ===================== */
  console.log("[public view-model]");
  const riskSig = mkSig({ domain: "bills", signalType: "bill_overdue", urgency: "high", effectiveDate: ago(3), estimatedCost: 120, key: "v:risk" });
  const oppSig = mkSig({ domain: "spending", signalType: "spending_opportunity", class: "recommendation", urgency: "low", confidence: "medium", estimatedUpside: "$30/mo", key: "v:opp" });
  const sel = rankSignals(collect([riskSig, oppSig]), rctx({ availableCash: 1000 }));
  const view = buildDailyBriefView({ today: NOW, generatedAt: CTX.now, signals: [riskSig, oppSig], selection: sel, suppressedKeys: new Set(), availableCash: 1000, activeMoveRow: null });
  ok("[1] view has the bounded public shape (date/generatedAt/today/whatChanged/risk/opportunity/move/degraded/lifecycle)", typeof view.date === "string" && typeof view.generatedAt === "string" && !!view.today && !!view.whatChanged && "risk" in view && "opportunity" in view && "recommendedMove" in view && Array.isArray(view.degraded) && !!view.lifecycle);
  const vjson = JSON.stringify(view);
  ok("[2] view exposes NO raw internals (collected/ranked/invalid/deduped/exclusions/breakdown/sql)", !/"collected"|"ranked"|"invalid"|"deduped"|"exclusions"|"breakdown"|"signalFingerprint"|"suppressedKeys"/.test(vjson));
  ok("[3] whatChanged is truthfully not_available", view.whatChanged.state === "not_available" && view.whatChanged.items.length === 0 && /baseline/i.test(view.whatChanged.message ?? ""));
  ok("[4] risk/opportunity are each zero-or-one bounded selected items", (view.risk === null || (typeof view.risk.key === "string" && "reasonSelected" in view.risk)) && (view.opportunity === null || "reasonSelected" in view.opportunity));
  ok("[5] risk item preserves provenance + sourceRefs (class + sourceRefs present)", !!view.risk && view.risk.class === "observed_fact" && Array.isArray(view.risk.sourceRefs));
  ok("[6] recommended move has bounded public shape + capacity + null personalRelevance", !!view.recommendedMove && ["ok", "tight", "unknown"].includes(view.recommendedMove.capacity) && view.recommendedMove.personalRelevance === null && typeof view.recommendedMove.nextAction === "string");
  ok("[7] move exposes upside/tradeoff/money/time/verification, not internal candidate arrays", !!view.recommendedMove && "expectedUpside" in view.recommendedMove && "tradeoff" in view.recommendedMove && "estimatedMoneyRequired" in view.recommendedMove && !("candidates" in view.recommendedMove));
  ok("[8] capacityResult: unknown when availableCash null for a costed move", capacityResult(riskSig, null) === "unknown" && capacityResult(riskSig, 1000) === "ok" && capacityResult(riskSig, 10) === "tight");
  ok("[9] capacityResult: no-cost move is ok even when cash unknown", capacityResult(mkSig({ domain: "tasks", signalType: "task_overdue", key: "v:free" }), null) === "ok");
  // Today section
  const todaySigs = [
    mkSig({ domain: "tasks", signalType: "task_overdue", urgency: "high", effectiveDate: ago(2), staleDate: ahead(1), key: "t:over" }),
    mkSig({ domain: "bills", signalType: "bill_due_soon", urgency: "medium", effectiveDate: ahead(2), staleDate: ahead(1), key: "t:soon" }),
    mkSig({ domain: "obligations", signalType: "obligation_due_soon", urgency: "medium", effectiveDate: NOW, staleDate: ahead(1), key: "t:today" }),
    mkSig({ domain: "credit", signalType: "utilization_high", urgency: "high", effectiveDate: null, staleDate: ahead(1), key: "t:credit" }), // not a Today domain
    mkSig({ domain: "tasks", signalType: "task_overdue", urgency: "high", effectiveDate: ago(1), staleDate: ago(1), key: "t:stale" }), // stale → excluded
  ];
  const today = buildToday(todaySigs, new Set(), NOW);
  ok("[10] Today: max 3 concrete dated items; ordered overdue→today→soon", today.length === 3 && today[0].key === "t:over" && today[1].key === "t:today" && today[2].key === "t:soon");
  ok("[11] Today excludes non-Today domains (credit) + stale items", !today.some((i) => i.key === "t:credit" || i.key === "t:stale"));
  ok("[12] Today excludes suppressed keys", !buildToday(todaySigs, new Set(["t:over"]), NOW).some((i) => i.key === "t:over"));
  ok("[13] Today empty (truthful) when nothing qualifies", buildToday([mkSig({ domain: "credit", signalType: "utilization_high", key: "x" })], new Set(), NOW).length === 0);
  ok("[14] Today deterministic for identical input", JSON.stringify(buildToday(todaySigs, new Set(), NOW)) === JSON.stringify(buildToday(todaySigs, new Set(), NOW)));

  /* ===================== GET /api/daily route [15-24] ===================== */
  console.log("\n[GET /api/daily]");
  // Seed an overdue high-priority task (owned by U) so at least one recommended move exists at real 'today'.
  const RT = localToday();
  const overdue = new Date(Date.parse(RT) - 30 * 86400000).toISOString().slice(0, 10);
  const [t1] = await db.insert(tasks).values({ userId: U, title: "ZZ4 Overdue", priority: "critical", status: "not_started", dueDate: overdue }).returning({ id: tasks.id }); created.tasks.push(t1.id);
  const before = (await db.select().from(dailyRecommendations).where(eq(dailyRecommendations.userId, U))).length;
  const g1 = await dailyGET();
  const gv = await bodyOf(g1) as unknown as ReturnType<typeof buildDailyBriefView>;
  const after = (await db.select().from(dailyRecommendations).where(eq(dailyRecommendations.userId, U))).length;
  ok("[15] GET returns 200 + bounded shape", g1.status === 200 && typeof gv.date === "string" && !!gv.today && "recommendedMove" in gv);
  ok("[16] GET is READ-ONLY — no lifecycle rows written", before === 0 && after === 0);
  ok("[17] GET date uses America/New_York local date", gv.date === localToday());
  ok("[18] GET exposes no raw internals or db rows", !/"collected"|"ranked"|"invalid"|"deduped"|"signalFingerprint"|"presentedCount".*"createdAt"/.test(JSON.stringify(gv)));
  ok("[19] GET Today has at most 3 items; risk/opp/move zero-or-one", gv.today.items.length <= 3 && (gv.risk === null || typeof gv.risk === "object") && (gv.recommendedMove === null || typeof gv.recommendedMove === "object"));
  ok("[20] GET whatChanged.state not_available", gv.whatChanged.state === "not_available");
  ok("[21] GET response is no-store", /no-store/.test(g1.headers.get("cache-control") ?? ""));
  const g2 = await dailyGET(); const gv2 = await bodyOf(g2) as unknown as typeof gv;
  ok("[22] GET Today ordering deterministic across calls", JSON.stringify(gv.today.items.map((i) => i.key)) === JSON.stringify(gv2.today.items.map((i) => i.key)));
  ok("[23] GET move (if any) carries capacity in {ok,tight,unknown} + null personalRelevance", gv.recommendedMove == null || (["ok", "tight", "unknown"].includes(gv.recommendedMove.capacity) && gv.recommendedMove.personalRelevance === null));
  ok("[24] a recommended move exists for the seeded overdue task scenario", gv.recommendedMove != null && typeof gv.recommendedMove.key === "string");
  const currentKey = gv.recommendedMove!.key;

  /* ===================== present route [25-31] ===================== */
  console.log("\n[present route]");
  const p1 = await presentPOST(new Request("http://t/", { method: "POST" }), params(currentKey));
  const pv1 = await bodyOf(p1);
  ok("[25] presenting the CURRENT key succeeds → one active row, presentedCount 1", p1.status === 200 && (pv1.lifecycle as { presentedCount: number }).presentedCount === 1 && (await db.select().from(dailyRecommendations).where(eq(dailyRecommendations.userId, U))).length === 1);
  const pBogus = await presentPOST(new Request("http://t/", { method: "POST" }), params("tasks:task_overdue:99999999"));
  ok("[26] presenting an arbitrary / not-current key is rejected (409)", pBogus.status === 409 && /not the currently recommended|no recommended|no longer/i.test((await bodyOf(pBogus)).error as string));
  const p2 = await presentPOST(new Request("http://t/", { method: "POST" }), params(currentKey));
  const pv2 = await bodyOf(p2);
  ok("[27] explicit repeat present reuses the row + increments count once (no duplicate)", p2.status === 200 && (pv2.lifecycle as { presentedCount: number }).presentedCount === 2 && (await db.select().from(dailyRecommendations).where(and(eq(dailyRecommendations.userId, U), isNull(dailyRecommendations.supersededAt), isNull(dailyRecommendations.deletedAt)))).length === 1);
  ok("[28] malformed key encoding rejected (400)", (await presentPOST(new Request("http://t/", { method: "POST" }), rawParams("%E0%A4%A"))).status === 400);
  ok("[29] oversized key rejected (400)", (await presentPOST(new Request("http://t/", { method: "POST" }), params("k".repeat(300)))).status === 400);
  ok("[30] blank key rejected (400)", (await presentPOST(new Request("http://t/", { method: "POST" }), rawParams("%20"))).status === 400);
  // after present, the row is pending (present doesn't respond); suppress by rejecting → no longer current
  await L.respondToRecommendation(U, currentKey, "reject", { now: NOWD, today: localToday() });
  ok("[31] a suppressed (rejected) key is no longer current → present rejected (409)", (await presentPOST(new Request("http://t/", { method: "POST" }), params(currentKey))).status === 409);
  await resetLifecycleU();

  /* ===================== respond route + service idempotency [32-46] ===================== */
  console.log("\n[respond route + idempotency]");
  // seed a pending active row for currentKey via the service so respond has a target
  const g3 = await dailyGET(); const key3 = (await bodyOf(g3) as unknown as typeof gv).recommendedMove!.key;
  await presentPOST(new Request("http://t/", { method: "POST" }), params(key3));
  const rAccept = await respondPOST(jReq({ response: "accept" }), params(key3));
  ok("[32] respond accept succeeds (200) + owner-scoped", rAccept.status === 200 && ((await bodyOf(rAccept)).lifecycle as { response: string }).response === "accept");
  ok("[33] malformed JSON rejected (400)", (await respondPOST(rawReq("{bad json"), params(key3))).status === 400);
  ok("[34] strict: unknown field (userId) rejected (400) — ownership never client-supplied", (await respondPOST(jReq({ response: "accept", userId: 999 }), params(key3))).status === 400);
  ok("[35] unknown response value rejected (400)", (await respondPOST(jReq({ response: "banana" }), params(key3))).status === 400);
  ok("[36] defer without deferUntil rejected (400)", (await respondPOST(jReq({ response: "defer" }), params(key3))).status === 400);
  ok("[37] defer with malformed date rejected (400)", (await respondPOST(jReq({ response: "defer", deferUntil: "07/15/2026" }), params(key3))).status === 400);
  ok("[38] defer with past date rejected (400)", (await respondPOST(jReq({ response: "defer", deferUntil: ago(2) }), params(key3))).status === 400);
  ok("[39] oversized note rejected (400)", (await respondPOST(jReq({ response: "accept", note: "x".repeat(600) }), params(key3))).status === 400);
  ok("[40] respond on missing/cross-owner key returns not found (404)", (await respondPOST(jReq({ response: "accept" }), params("tasks:task_overdue:does-not-exist"))).status === 404);
  // Issue #3 — JSON-only content type + strict calendar dates + defer-field semantics (route level)
  ok("[40a] missing Content-Type rejected (415)", (await respondPOST(noCtReq({ response: "accept" }), params(key3))).status === 415);
  ok("[40b] non-JSON Content-Type rejected (415)", (await respondPOST(jReqCT({ response: "accept" }, "text/plain"), params(key3))).status === 415);
  ok("[40c] application/json; charset=utf-8 accepted (200)", (await respondPOST(jReqCT({ response: "accept" }, "application/json; charset=utf-8"), params(key3))).status === 200);
  ok("[40d] impossible calendar date (2026-02-29) rejected (400)", (await respondPOST(jReq({ response: "defer", deferUntil: "2026-02-29" }), params(key3))).status === 400 && (await respondPOST(jReq({ response: "defer", deferUntil: "2026-04-31" }), params(key3))).status === 400 && (await respondPOST(jReq({ response: "defer", deferUntil: "2026-13-01" }), params(key3))).status === 400 && (await respondPOST(jReq({ response: "defer", deferUntil: "2026-00-10" }), params(key3))).status === 400);
  ok("[40e] valid leap-year date (2028-02-29) accepted for a future defer (200)", (await respondPOST(jReq({ response: "defer", deferUntil: "2028-02-29" }), params(key3))).status === 200);
  ok("[40f] deferUntil supplied with a non-defer response rejected (400)", (await respondPOST(jReq({ response: "accept", deferUntil: ahead(5) }), params(key3))).status === 400 && (await respondPOST(jReq({ response: "reject", deferUntil: ahead(5) }), params(key3))).status === 400 && (await respondPOST(jReq({ response: "complete", deferUntil: ahead(5) }), params(key3))).status === 400 && (await respondPOST(jReq({ response: "pending", deferUntil: ahead(5) }), params(key3))).status === 400);
  ok("[40g] valid future defer accepted (200)", (await respondPOST(jReq({ response: "defer", deferUntil: "2030-06-15" }), params(key3))).status === 200);
  ok("[40h] isStrictISODate rejects rollover dates the lenient parser accepts", !isStrictISODate("2026-02-29") && !isStrictISODate("2026-04-31") && !isStrictISODate("2026-13-01") && !isStrictISODate("2026-01-00") && isStrictISODate("2028-02-29") && isStrictISODate("2026-07-01"));
  // service-level idempotency + timestamps (injected now/today for determinism)
  await resetLifecycleU();
  const isig = mkSig({ domain: "credit", signalType: "credit_action", class: "recommendation", key: "z4:idem", candidateAction: "do" });
  await L.presentRecommendation(U, isig, L.buildSnapshot(isig, "r"), CTX, { now: NOWD });
  const rj1 = await L.respondToRecommendation(U, "z4:idem", "reject", { note: "n", now: NOWD, today: NOW });
  const rj2 = await L.respondToRecommendation(U, "z4:idem", "reject", { note: "n", now: new Date("2026-07-05T00:00:00Z"), today: "2026-07-05" });
  ok("[41] identical repeated response is idempotent — respondedAt + cooldown preserved", rj1.respondedAt!.getTime() === rj2.respondedAt!.getTime());
  const rj3 = await L.respondToRecommendation(U, "z4:idem", "reject", { note: "different", now: new Date("2026-07-06T00:00:00Z"), today: "2026-07-06" });
  ok("[42] a changed note is a genuine correction (respondedAt advances)", rj3.respondedAt!.getTime() > rj1.respondedAt!.getTime() && rj3.responseNote === "different");
  const cp1 = await L.respondToRecommendation(U, "z4:idem", "complete", { now: NOWD, today: NOW });
  const cp2 = await L.respondToRecommendation(U, "z4:idem", "complete", { now: new Date("2026-07-09T00:00:00Z"), today: "2026-07-09" });
  ok("[43] identical complete retry preserves completedAt", cp1.completedAt!.getTime() === cp2.completedAt!.getTime());
  const df1 = await L.respondToRecommendation(U, "z4:idem", "defer", { deferUntil: ahead(5), now: NOWD, today: NOW });
  const df2 = await L.respondToRecommendation(U, "z4:idem", "defer", { deferUntil: ahead(5), now: new Date("2026-07-02T00:00:00Z"), today: "2026-07-02" });
  ok("[44] identical defer retry preserves respondedAt", df1.respondedAt!.getTime() === df2.respondedAt!.getTime());
  const rp1 = await L.respondToRecommendation(U, "z4:idem", "pending", { now: NOWD });
  ok("[45] pending reopens the row; retrying pending is a no-op", rp1.response === "pending" && (await L.respondToRecommendation(U, "z4:idem", "pending", { now: NOWD })).response === "pending");
  // superseded/deleted cannot be mutated via the endpoint (activeRow excludes them → 404)
  await db.update(dailyRecommendations).set({ deletedAt: NOWD }).where(and(eq(dailyRecommendations.userId, U), eq(dailyRecommendations.recommendationKey, "z4:idem")));
  ok("[46] a deleted/superseded row is not active → respond returns 404", (await respondPOST(jReq({ response: "accept" }), params("z4:idem"))).status === 404);
  await resetLifecycleU();

  /* ===================== outcome route [47-54] ===================== */
  console.log("\n[outcome route]");
  const osig = mkSig({ domain: "credit", signalType: "credit_action", class: "recommendation", key: "z4:out", candidateAction: "do" });
  await L.presentRecommendation(U, osig, L.buildSnapshot(osig, "r"), CTX, { now: NOWD });
  ok("[47] outcome on a NON-complete row rejected (409)", (await outcomePOST(jReq({ verificationState: "verified" }), params("z4:out"))).status === 409);
  await L.respondToRecommendation(U, "z4:out", "complete", { now: NOWD, today: NOW });
  ok("[48] outcome on a complete row accepts a verification state (200)", (await outcomePOST(jReq({ verificationState: "verified" }), params("z4:out"))).status === 200);
  ok("[49] outcome accepts an outcome note (200)", (await outcomePOST(jReq({ outcomeNote: "did it" }), params("z4:out"))).status === 200);
  const oBoth = await outcomePOST(jReq({ outcomeNote: "note", verificationState: "could_not_verify" }), params("z4:out"));
  ok("[50] outcome accepts both together (200)", oBoth.status === 200 && ((await bodyOf(oBoth)).lifecycle as { verificationState: string }).verificationState === "could_not_verify");
  ok("[51] empty outcome body rejected (400)", (await outcomePOST(jReq({}), params("z4:out"))).status === 400);
  ok("[52] invalid verification state rejected (400)", (await outcomePOST(jReq({ verificationState: "maybe" }), params("z4:out"))).status === 400);
  ok("[53] oversized outcome note rejected (400)", (await outcomePOST(jReq({ outcomeNote: "x".repeat(1200) }), params("z4:out"))).status === 400);
  const oIdem1 = (await bodyOf(await outcomePOST(jReq({ verificationState: "verified" }), params("z4:out")))).lifecycle as { verificationState: string };
  const oIdem2 = (await bodyOf(await outcomePOST(jReq({ verificationState: "verified" }), params("z4:out")))).lifecycle as { verificationState: string };
  ok("[54] identical outcome retry is idempotent", oIdem1.verificationState === "verified" && oIdem2.verificationState === "verified");
  ok("[54a] outcome route enforces JSON content type (missing → 415, text/plain → 415, charset ok → 200)", (await outcomePOST(noCtReq({ verificationState: "verified" }), params("z4:out"))).status === 415 && (await outcomePOST(jReqCT({ verificationState: "verified" }, "text/plain"), params("z4:out"))).status === 415 && (await outcomePOST(jReqCT({ verificationState: "verified" }, "application/json; charset=utf-8"), params("z4:out"))).status === 200);
  await resetLifecycleU();

  /* ===================== cross-owner isolation [55-57] ===================== */
  console.log("\n[cross-owner isolation]");
  const [other] = await db.insert(users).values({ email: `zz4-other-${Date.now()}@example.test`, name: "ZZ4 Other" }).returning({ id: users.id }); created.otherUser = other.id;
  const osig2 = mkSig({ domain: "credit", signalType: "credit_action", class: "recommendation", key: "z4:cross", candidateAction: "do" });
  await L.presentRecommendation(other.id, osig2, L.buildSnapshot(osig2, "r"), CTX, { now: NOWD });
  await L.respondToRecommendation(other.id, "z4:cross", "complete", { now: NOWD, today: NOW });
  ok("[55] another owner's key returns not-found via respond (no existence leak)", (await respondPOST(jReq({ response: "accept" }), params("z4:cross"))).status === 404);
  ok("[56] another owner's key returns not-found via outcome", (await outcomePOST(jReq({ verificationState: "verified" }), params("z4:cross"))).status === 404);
  ok("[57] the other owner's row is untouched by owner-scoped calls", (await L.getActiveRecommendation(other.id, "z4:cross"))!.response === "complete");

  /* ============ fingerprint-aware suppression + stale-lifecycle gating in GET [F1-F7] ============ */
  console.log("\n[fingerprint-aware GET]");
  await resetLifecycleU();
  const fMoveKey = (await bodyOf(await dailyGET()) as unknown as typeof gv).recommendedMove!.key;
  // F1 — a fresh present writes a pending row whose fingerprint matches the live signal → GET exposes it.
  await presentPOST(new Request("http://t/", { method: "POST" }), params(fMoveKey));
  const gExpose = await bodyOf(await dailyGET()) as unknown as typeof gv;
  ok("[F1] matching-fingerprint lifecycle is exposed on the selected move (pending)", gExpose.recommendedMove?.key === fMoveKey && gExpose.recommendedMove?.lifecycle?.response === "pending" && gExpose.lifecycle.activeRecommendation?.response === "pending");
  // F2/F3 — owner accepts; the stored row is then forced to represent a PRIOR material condition
  // (fingerprint no longer matches). The changed condition un-suppresses the key (still selectable),
  // but its stale accept must NOT surface as the new move's lifecycle.
  await respondPOST(jReq({ response: "accept" }), params(fMoveKey));
  await db.update(dailyRecommendations).set({ signalFingerprint: "stale-fp-prior-condition" }).where(and(eq(dailyRecommendations.userId, U), eq(dailyRecommendations.recommendationKey, fMoveKey), isNull(dailyRecommendations.supersededAt), isNull(dailyRecommendations.deletedAt)));
  const gStale = await bodyOf(await dailyGET()) as unknown as typeof gv;
  ok("[F2] a materially-changed accepted key is NOT suppressed in ranking/Today (fingerprint-aware run.suppression)", gStale.recommendedMove?.key === fMoveKey);
  ok("[F3] stale-fingerprint lifecycle (old accept) is NOT exposed as the new move's state", gStale.recommendedMove?.lifecycle === null && gStale.lifecycle.activeRecommendation === null);
  // F4 — explicit presentation supersedes the stale row → GET exposes a fresh pending lifecycle.
  const beforePresent = (await db.select().from(dailyRecommendations).where(and(eq(dailyRecommendations.userId, U), isNull(dailyRecommendations.supersededAt), isNull(dailyRecommendations.deletedAt)))).length;
  await presentPOST(new Request("http://t/", { method: "POST" }), params(fMoveKey));
  const gAfter = await bodyOf(await dailyGET()) as unknown as typeof gv;
  ok("[F4] explicit presentation supersedes the stale row → GET exposes the new pending lifecycle", beforePresent === 1 && gAfter.recommendedMove?.lifecycle?.response === "pending");
  // F5 — GET is write-free.
  const cntA = (await db.select().from(dailyRecommendations).where(eq(dailyRecommendations.userId, U))).length;
  await dailyGET(); await dailyGET();
  const cntB = (await db.select().from(dailyRecommendations).where(eq(dailyRecommendations.userId, U))).length;
  ok("[F5] GET remains write-free (row count unchanged across reads)", cntA === cntB && cntA > 0);
  // F6 — service proof: fingerprint-aware suppression un-suppresses a changed accepted key; a
  // fingerprint-less lookup (the removed second query) would conservatively re-suppress it.
  await resetLifecycleU();
  const fsig = mkSig({ domain: "tasks", signalType: "task_overdue", key: "z4:fp", effectiveDate: ago(2), staleDate: ahead(3) });
  await L.presentRecommendation(U, fsig, L.buildSnapshot(fsig, "r"), CTX, { now: NOWD });
  await L.respondToRecommendation(U, "z4:fp", "accept", { now: NOWD, today: NOW });
  const changed: DailySignal = { ...fsig, urgency: "high" }; // materially changed (urgency is a fingerprint field), same key
  const awareSet = L.suppressedKeySet(await L.getSuppression(U, NOW, new Map([["z4:fp", fingerprintOfSignal(changed)]])));
  const blindSet = L.suppressedKeySet(await L.getSuppression(U, NOW)); // fingerprint-less (conservative)
  ok("[F6] fingerprint-aware suppression excludes a changed key; fingerprint-less would re-suppress it", fingerprintOfSignal(changed) !== fingerprintOfSignal(fsig) && !awareSet.has("z4:fp") && blindSet.has("z4:fp"));
  // F7 — GET wires ONE suppression interpretation (run.suppression) + fingerprint-gated lifecycle.
  const getSrc = readFileSync("app/api/daily/route.ts", "utf8");
  ok("[F7] GET uses run.suppression only (no fingerprint-less loadSuppressedKeys) + gates lifecycle by fingerprint", /run\.suppression/.test(getSrc) && !/loadSuppressedKeys/.test(getSrc) && /signalFingerprint === fingerprintOfSignal/.test(getSrc));
  await resetLifecycleU();

  /* ===================== purity / boundaries [58-62] ===================== */
  console.log("\n[purity / boundaries]");
  const routeSrc = ["app/api/daily/route.ts", "app/api/daily/recommendations/[key]/present/route.ts", "app/api/daily/recommendations/[key]/respond/route.ts", "app/api/daily/recommendations/[key]/outcome/route.ts"].map((p) => readFileSync(p, "utf8")).join("\n");
  const dailySrc = routeSrc + readFileSync("lib/daily/view.ts", "utf8") + readFileSync("lib/daily/api-helpers.ts", "utf8");
  ok("[58] GET route does not present (no lifecycle write on read)", !/present:\s*true|incrementPresentation/.test(readFileSync("app/api/daily/route.ts", "utf8")));
  ok("[59] routes/view/helpers make no external/AI/network call", !/anthropic|openai|fetch\(|https?:\/\/|plaidClient/i.test(dailySrc));
  ok("[60] no consequential action (no money/transfer/publish/apply/delete of source records)", !/createTransfer|payBill|receiveIncome|moveMoney|sendEmail|publish|applyFor|db\.delete\((tasks|financialEntries|creditAccounts|importedTransactions)/i.test(dailySrc));
  ok("[61] no source-domain table writes in routes/view/helpers (only lifecycle via service)", !/db\.(insert|update|delete)\(/.test(routeSrc + readFileSync("lib/daily/view.ts", "utf8")));
  ok("[62] no new migration (latest is 0023)", readFileSync("db/migrations/meta/_journal.json", "utf8").includes("0023_supersede_function") && !/0024_/.test(readFileSync("db/migrations/meta/_journal.json", "utf8")));

  /* ===================== owner protection + cleanup [63-66] ===================== */
  console.log("\n[owner protection]");
  await cleanup();
  const conns = await db.select().from(financialConnections).where(and(eq(financialConnections.userId, U), isNull(financialConnections.deletedAt)));
  const bofa = conns.find((x) => /bank of america/i.test(x.institutionName ?? ""));
  const accts = await db.select().from(financialAccounts).where(and(eq(financialAccounts.userId, U), isNull(financialAccounts.deletedAt)));
  const linked = accts.filter((x) => x.balanceSource === "linked"); let orphan = 0;
  for (const l of linked) { const m = await db.select().from(providerAccounts).where(and(eq(providerAccounts.financialAccountId, l.id), isNull(providerAccounts.deletedAt))); if (m.length !== 1) orphan++; }
  ok("[63] BofA Sandbox active; Plaid linked; imported txns intact; no orphan", bofa?.status === "active" && accts.some((x) => x.name === "Plaid Checking" && x.balanceSource === "linked") && (await db.select().from(importedTransactions).where(eq(importedTransactions.userId, U))).length === impBefore && orphan === 0);
  ok("[64] request 222 present", (await db.select().from(experienceRequests).where(eq(experienceRequests.id, 222))).length === 1);
  ok("[65] no temp lifecycle rows / temp task fixtures remain", (await db.select().from(dailyRecommendations).where(eq(dailyRecommendations.userId, U))).length === 0 && (await db.select().from(tasks).where(and(eq(tasks.userId, U), inArray(tasks.id, created.tasks.length ? created.tasks : [-1])))).length === 0);
  ok("[66] temp secondary user removed (users back to owner only)", (await db.select().from(users).where(eq(users.id, created.otherUser || -1))).length === 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch(async (e) => { try { await cleanup(); } catch { /* noop */ } console.error(e); process.exit(1); });
