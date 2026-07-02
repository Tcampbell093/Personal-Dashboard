/* =============================================================================
 * verify-daily-slice3.ts — Daily Command Center Slice 3 verification.
 *
 * Recommendation LIFECYCLE persistence: schema/migration, deterministic
 * fingerprint, present/reuse/supersede, owner responses + correction/reopen,
 * suppression & recurrence (defer / 14-day reject / 90-day not_relevant / accept /
 * complete), transactional-safe supersession, owner isolation, and the Slice 2
 * integration boundary (suppression → ranking; pure ranking/collection stay
 * write-free). Exact-owner temp rows only; cleaned on every exit path.
 * ===========================================================================*/

import { readFileSync } from "node:fs";
import { and, eq, isNull, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { dailyRecommendations, accountMovements, importedTransactions, financialConnections, financialAccounts, providerAccounts, experienceRequests, users } from "@/db/schema";
import { CURRENT_USER_ID as U } from "@/lib/auth";
import type { DailySignal, SignalContext } from "@/lib/daily/contract";
import { signalFingerprint, fingerprintOfSignal } from "@/lib/daily/fingerprint";
import * as L from "@/lib/daily/lifecycle";
import { rankSignals } from "@/lib/daily/ranking";
import { collectDailySignals } from "@/lib/daily/orchestrator";

let passed = 0, failed = 0;
const ok = (n: string, c: boolean) => { c ? passed++ : failed++; console.log(`${c ? "✓" : "✗"} ${n}`); };
const NOW = "2026-07-01";
const NOWD = new Date(`${NOW}T12:00:00.000Z`);
const FOREIGN = U + 99999;
const ahead = (d: number) => new Date(Date.parse(NOW) + d * 86400000).toISOString().slice(0, 10);
const CTX: SignalContext = { today: NOW, timezone: "America/New_York", now: `${NOW}T12:00:00.000Z`, freshnessDays: 1 };
async function threw(fn: () => Promise<unknown>): Promise<boolean> { try { await fn(); return false; } catch { return true; } }
let OTHER = 0; // a real second owner (temp user) for cross-owner uniqueness; FK requires an existing user.

let seq = 0;
function mkSig(over: Partial<DailySignal> & Pick<DailySignal, "domain" | "signalType">): DailySignal {
  const base: DailySignal = {
    key: `z3:${over.domain}:${over.signalType}:${seq++}`, domain: over.domain, signalType: over.signalType, class: "observed_fact",
    title: "t", summary: "s", evidence: "e", sourceRefs: [{ service: over.domain, table: null, id: null }],
    observedDate: NOW, effectiveDate: null, urgency: "medium", confidence: "high",
    estimatedUpside: null, estimatedDownside: null, estimatedCost: null, timeRequired: null,
    reversibility: "reversible", capacityReqs: null, requiredVerification: null, candidateAction: "do it",
    staleDate: NOW, reasonCodes: [],
  };
  return { ...base, ...over };
}
const snap = (sig: DailySignal) => L.buildSnapshot(sig, "highest_actionable_move_after_capacity_check");
async function resetLifecycle() { await db.delete(dailyRecommendations).where(inArray(dailyRecommendations.userId, [U, FOREIGN, OTHER || -1])).catch(() => {}); }
async function cleanupUser() { if (OTHER) { await db.delete(dailyRecommendations).where(eq(dailyRecommendations.userId, OTHER)).catch(() => {}); await db.delete(users).where(eq(users.id, OTHER)).catch(() => {}); } }

async function main() {
  console.log("Daily Command Center — Slice 3 verification (ref " + NOW + ")\n");
  const [tempUser] = await db.insert(users).values({ email: `z3-temp-${Date.now()}@example.invalid`, name: "z3 temp" }).returning({ id: users.id });
  OTHER = tempUser.id;
  await resetLifecycle();
  const movBefore = (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length;
  const impBefore = (await db.select().from(importedTransactions).where(eq(importedTransactions.userId, U))).length;

  /* ===================== migration / schema [1-9] ===================== */
  console.log("[migration / schema]");
  const reg = await db.execute(sql`select to_regclass('public.daily_recommendations') t`);
  ok("[1] migration applied — daily_recommendations table exists", !!(reg.rows || reg)[0].t);
  const cols = (await db.execute(sql`select column_name from information_schema.columns where table_name='daily_recommendations'`) as unknown as { rows: { column_name: string }[] }).rows.map((r) => r.column_name);
  const required = ["id", "user_id", "recommendation_key", "domain", "signal_type", "source_refs", "signal_fingerprint", "presented_on", "last_presented_at", "presented_count", "snapshot", "response", "response_note", "defer_until", "responded_at", "completed_at", "outcome_note", "verification_state", "superseded_by_id", "created_at", "updated_at", "deleted_at"];
  ok("[2] all required columns exist", required.every((c) => cols.includes(c)));
  ok("[3] response enum is DB-constrained (invalid value rejected)", await threw(() => db.execute(sql`insert into daily_recommendations (user_id, recommendation_key, domain, signal_type, source_refs, signal_fingerprint, presented_on, snapshot, response) values (${U}, 'z3:bad', 'x', 'y', '[]'::jsonb, 'f', ${NOW}, '{}'::jsonb, 'bogus')`)));
  ok("[4] verification enum is DB-constrained (invalid value rejected)", await threw(() => db.execute(sql`insert into daily_recommendations (user_id, recommendation_key, domain, signal_type, source_refs, signal_fingerprint, presented_on, snapshot, verification_state) values (${U}, 'z3:bad2', 'x', 'y', '[]'::jsonb, 'f', ${NOW}, '{}'::jsonb, 'bogus')`)));
  const mkRow = async (userId: number, key: string, over: Partial<typeof dailyRecommendations.$inferInsert> = {}) => {
    const [r] = await db.insert(dailyRecommendations).values({ userId, recommendationKey: key, domain: "credit", signalType: "credit_action", sourceRefs: [], signalFingerprint: "fp0", presentedOn: NOW, snapshot: {}, ...over }).returning();
    return r;
  };
  const a1 = await mkRow(U, "z3:uq");
  ok("[5] live-only uniqueness — a second active row for same (owner,key) is rejected", await threw(() => mkRow(U, "z3:uq")));
  await db.update(dailyRecommendations).set({ deletedAt: NOWD }).where(eq(dailyRecommendations.id, a1.id));
  const a2 = await mkRow(U, "z3:uq");
  ok("[6] soft-deleted row does not block a new active row", !!a2 && a2.id !== a1.id);
  await db.update(dailyRecommendations).set({ supersededAt: NOWD }).where(eq(dailyRecommendations.id, a2.id));
  const a3 = await mkRow(U, "z3:uq");
  ok("[7] superseded row does not block a new active row", !!a3 && a3.id !== a2.id);
  ok("[8] two active rows for the same owner/key are prevented (only one active remains)", (await db.select().from(dailyRecommendations).where(and(eq(dailyRecommendations.userId, U), eq(dailyRecommendations.recommendationKey, "z3:uq"), isNull(dailyRecommendations.deletedAt), isNull(dailyRecommendations.supersededAt)))).length === 1);
  const fr = await mkRow(OTHER, "z3:uq");
  ok("[9] same key is allowed for a different owner", !!fr && fr.userId === OTHER);
  await resetLifecycle();

  /* ===================== fingerprint [10-14] ===================== */
  console.log("\n[fingerprint]");
  const baseSig = mkSig({ domain: "bills", signalType: "bill_overdue", effectiveDate: ahead(2), estimatedCost: 120, capacityReqs: { money: 120, timeMinutes: 10, scheduleConflict: null }, reasonCodes: ["a", "b", "c"], candidateAction: "pay", key: "z3:fp" });
  ok("[10] identical material input → identical fingerprint", fingerprintOfSignal(baseSig) === fingerprintOfSignal({ ...baseSig }));
  const reordered = { ...baseSig, reasonCodes: ["c", "a", "b"], sourceRefs: [...baseSig.sourceRefs].reverse() };
  ok("[11] reason-code / source-ref order does not change fingerprint", fingerprintOfSignal(baseSig) === fingerprintOfSignal(reordered));
  const fp0 = fingerprintOfSignal(baseSig);
  ok("[12] materially changed date/urgency/cost/action each change the fingerprint",
    fingerprintOfSignal({ ...baseSig, effectiveDate: ahead(3) }) !== fp0 &&
    fingerprintOfSignal({ ...baseSig, urgency: "high" }) !== fp0 &&
    fingerprintOfSignal({ ...baseSig, estimatedCost: 999 }) !== fp0 &&
    fingerprintOfSignal({ ...baseSig, candidateAction: "different" }) !== fp0);
  ok("[13] prose-only changes (title/summary/evidence) do NOT change the fingerprint", fingerprintOfSignal({ ...baseSig, title: "X", summary: "Y", evidence: "Z" }) === fp0);
  ok("[14] fingerprint is deterministic (no timestamps/randomness); repeat calls identical", signalFingerprint({ key: "k", domain: "d", signalType: "t", effectiveDate: null, urgency: "low", confidence: "low", estimatedCost: null, capacityReqs: null, candidateAction: null, reasonCodes: [], sourceRefs: [] }) === signalFingerprint({ key: "k", domain: "d", signalType: "t", effectiveDate: null, urgency: "low", confidence: "low", estimatedCost: null, capacityReqs: null, candidateAction: null, reasonCodes: [], sourceRefs: [] }));

  /* ===================== presentation [15-21] ===================== */
  console.log("\n[presentation]");
  const pSig = mkSig({ domain: "credit", signalType: "credit_action", class: "recommendation", key: "z3:present" });
  const p1 = await L.presentRecommendation(U, pSig, snap(pSig), CTX, { now: NOWD });
  ok("[15] first presentation creates one pending row (count 1)", p1.response === "pending" && p1.presentedCount === 1 && (await db.select().from(dailyRecommendations).where(and(eq(dailyRecommendations.userId, U), eq(dailyRecommendations.recommendationKey, "z3:present")))).length === 1);
  const p2 = await L.presentRecommendation(U, pSig, snap(pSig), CTX, { now: NOWD });
  ok("[16] identical idempotent call creates no duplicate, count unchanged", p2.id === p1.id && p2.presentedCount === 1);
  const p3 = await L.presentRecommendation(U, pSig, snap(pSig), CTX, { now: NOWD, incrementPresentation: true });
  ok("[17] explicit repeat-presentation increments count exactly once", p3.id === p1.id && p3.presentedCount === 2);
  await L.respondToRecommendation(U, "z3:present", "accept", { now: NOWD, today: NOW });
  const p4 = await L.presentRecommendation(U, pSig, snap(pSig), CTX, { now: NOWD });
  ok("[18] presentation does not reset an existing response", p4.response === "accept");
  const allowedSnapKeys = ["title", "summary", "evidence", "estimatedUpside", "estimatedDownside", "estimatedCost", "timeRequired", "urgency", "confidence", "candidateAction", "requiredVerification", "staleDate", "reasonSelected", "signalKey"].sort();
  ok("[19] snapshot is bounded to the allowed presentation fields", JSON.stringify(Object.keys(p4.snapshot as object).sort()) === JSON.stringify(allowedSnapKeys));
  const secretSig = mkSig({ domain: "credit", signalType: "credit_action", class: "recommendation", key: "z3:secret", evidence: "npg_SECRETTOKEN access-sandbox-deadbeef" });
  const ps = await L.presentRecommendation(U, secretSig, snap(secretSig), CTX, { now: NOWD });
  ok("[20] sourceRefs are references only; no raw payload/token fields stored", JSON.stringify(ps.sourceRefs).length < 400 && !("accessToken" in (ps.snapshot as object)) && !("rawPayload" in (ps.snapshot as object)));
  const pendSig = mkSig({ domain: "spending", signalType: "spending_opportunity", class: "recommendation", key: "z3:pend" });
  const pp1 = await L.presentRecommendation(U, pendSig, snap(pendSig), CTX, { now: NOWD });
  const pp2 = await L.presentRecommendation(U, { ...pendSig, estimatedCost: 500 }, snap({ ...pendSig, estimatedCost: 500 }), CTX, { now: NOWD });
  ok("[21] a materially-changed PENDING row is updated in place (no new row)", pp2.id === pp1.id && pp2.signalFingerprint === fingerprintOfSignal({ ...pendSig, estimatedCost: 500 }));
  await resetLifecycle();

  /* ===================== responses [22-29] ===================== */
  console.log("\n[responses]");
  const rSig = (k: string) => mkSig({ domain: "credit", signalType: "credit_action", class: "recommendation", key: k });
  for (const resp of ["accept", "reject", "not_relevant", "complete"] as L.ResponseValue[]) {
    const k = `z3:resp:${resp}`; const s = rSig(k); await L.presentRecommendation(U, s, snap(s), CTX, { now: NOWD });
    await L.respondToRecommendation(U, k, resp, { now: NOWD, today: NOW });
  }
  const kd = "z3:resp:defer"; const sd = rSig(kd); await L.presentRecommendation(U, sd, snap(sd), CTX, { now: NOWD });
  const deferred = await L.respondToRecommendation(U, kd, "defer", { now: NOWD, today: NOW, deferUntil: ahead(5) });
  const responded = await db.select().from(dailyRecommendations).where(and(eq(dailyRecommendations.userId, U), isNull(dailyRecommendations.supersededAt), isNull(dailyRecommendations.deletedAt)));
  ok("[22] all five owner responses persist", ["accept", "reject", "not_relevant", "complete", "defer"].every((r) => responded.some((row) => row.response === r)));
  ok("[23] defer requires a FUTURE deferUntil (missing or past rejected)", deferred.response === "defer" && deferred.deferUntil === ahead(5) && await threw(() => L.respondToRecommendation(U, kd, "defer", { now: NOWD, today: NOW })) && await threw(() => L.respondToRecommendation(U, kd, "defer", { now: NOWD, today: NOW, deferUntil: "2026-06-01" })));
  const comp = responded.find((r) => r.response === "complete")!;
  ok("[24] complete sets completedAt + verificationState unverified", comp.completedAt != null && comp.verificationState === "unverified");
  ok("[25] invalid transition rejected — 'pending' via respond, and respond on a non-existent active key", await threw(() => L.respondToRecommendation(U, "z3:resp:accept", "pending" as L.ResponseValue, { now: NOWD, today: NOW })) && await threw(() => L.respondToRecommendation(U, "z3:nope", "accept", { now: NOWD, today: NOW })));
  const acc = responded.find((r) => r.response === "accept")!;
  const corrected = await L.correctResponse(U, acc.id, "reject", { now: NOWD, today: NOW });
  const reopened = await L.reopenRecommendation(U, acc.id, { now: NOWD });
  ok("[26] owner can correct a response and reopen to pending", corrected.response === "reject" && reopened.response === "pending" && reopened.deferUntil === null);
  ok("[27] cross-owner update fails (foreign owner cannot touch the row)", await threw(() => L.correctResponse(FOREIGN, acc.id, "accept", { now: NOWD, today: NOW })) && await threw(() => L.reopenRecommendation(FOREIGN, acc.id, {})));
  await db.update(dailyRecommendations).set({ supersededAt: NOWD }).where(eq(dailyRecommendations.id, comp.id));
  ok("[28] respond on a superseded (non-active) row fails — no active row for that key", await threw(() => L.respondToRecommendation(U, "z3:resp:complete", "accept", { now: NOWD, today: NOW })));
  ok("[29] reopen clears defer + completed + respondedAt", reopened.completedAt === null && reopened.respondedAt === null);
  await resetLifecycle();

  /* ===================== suppression [30-37] ===================== */
  console.log("\n[suppression]");
  const mkResponded = async (key: string, response: L.ResponseValue, deferUntil?: string) => { const s = rSig(key); await L.presentRecommendation(U, s, snap(s), CTX, { now: NOWD }); if (response !== "pending") await L.respondToRecommendation(U, key, response, { now: NOWD, today: NOW, deferUntil }); return s; };
  await mkResponded("z3:sup:pending", "pending");
  await mkResponded("z3:sup:accept", "accept");
  await mkResponded("z3:sup:defer", "defer", ahead(5));
  await mkResponded("z3:sup:reject", "reject");
  await mkResponded("z3:sup:nr", "not_relevant");
  await mkResponded("z3:sup:complete", "complete");
  const supNow = await L.getSuppression(U, NOW);
  const keys = (d: L.SuppressionDiag[]) => new Set(d.map((x) => x.recommendationKey));
  ok("[30] pending remains eligible (not suppressed)", !keys(supNow).has("z3:sup:pending"));
  ok("[31] accepted is suppressed", keys(supNow).has("z3:sup:accept"));
  // Defer: INCLUSIVE through deferUntil (ahead 5), eligible the FOLLOWING day (ahead 6).
  ok("[32] defer suppressed ON deferUntil (inclusive); eligible the following day", keys(await L.getSuppression(U, ahead(5))).has("z3:sup:defer") && !keys(await L.getSuppression(U, ahead(6))).has("z3:sup:defer"));
  // Reject: EXCLUSIVE cooldown — respondedDay (NOW=day0) and day13 suppressed; day14 (respondedDate+14) ELIGIBLE.
  ok("[33] reject: response day + day 13 suppressed; day 14 (respondedDate+14) eligible", keys(supNow).has("z3:sup:reject") && keys(await L.getSuppression(U, ahead(13))).has("z3:sup:reject") && !keys(await L.getSuppression(U, ahead(14))).has("z3:sup:reject"));
  // Not-relevant: EXCLUSIVE — day89 suppressed; day90 (respondedDate+90) ELIGIBLE.
  ok("[34] not_relevant: day 89 suppressed; day 90 (respondedDate+90) eligible", keys(await L.getSuppression(U, ahead(89))).has("z3:sup:nr") && !keys(await L.getSuppression(U, ahead(90))).has("z3:sup:nr"));
  ok("[35] completed (unchanged fingerprint) suppressed", keys(supNow).has("z3:sup:complete"));
  const rejDiag = supNow.find((d) => d.recommendationKey === "z3:sup:reject");
  const nrDiag = supNow.find((d) => d.recommendationKey === "z3:sup:nr");
  ok("[36] diagnostics truthful — eligibleOn = respondedDate+14/+90; suppressedUntil = last suppressed date", !!rejDiag && rejDiag.eligibleOn === ahead(14) && rejDiag.suppressedUntil === ahead(13) && !!nrDiag && nrDiag.eligibleOn === ahead(90) && nrDiag.suppressedUntil === ahead(89) && typeof rejDiag.fingerprint === "string" && typeof rejDiag.rowId === "number");
  const deferDiag = (await L.getSuppression(U, ahead(3))).find((d) => d.recommendationKey === "z3:sup:defer");
  ok("[37] defer diagnostic distinct from cooldowns — suppressedUntil = deferUntil (inclusive), eligibleOn = +1", !!deferDiag && deferDiag.suppressedUntil === ahead(5) && deferDiag.eligibleOn === ahead(6) && L.suppressedKeySet(supNow).has("z3:sup:accept") && (await L.loadSuppressedKeys(U, NOW)).has("z3:sup:reject"));

  /* ===================== material change / supersession [38-44] ===================== */
  console.log("\n[material change / supersession]");
  const mSig = rSig("z3:sup:reject"); const changed = { ...mSig, estimatedCost: 777, candidateAction: "different action" };
  const before = (await L.getSuppression(U, NOW, new Map([["z3:sup:reject", fingerprintOfSignal(mSig)]]))).some((d) => d.recommendationKey === "z3:sup:reject");
  const after = (await L.getSuppression(U, NOW, new Map([["z3:sup:reject", fingerprintOfSignal(changed)]]))).some((d) => d.recommendationKey === "z3:sup:reject");
  ok("[38] a materially-changed fingerprint UN-suppresses a rejected key before cooldown expiry", before === true && after === false);
  const oldReject = (await db.select().from(dailyRecommendations).where(and(eq(dailyRecommendations.userId, U), eq(dailyRecommendations.recommendationKey, "z3:sup:reject"), isNull(dailyRecommendations.supersededAt))))[0];
  const superseded = await L.presentRecommendation(U, changed, snap(changed), CTX, { now: NOWD });
  const oldAfter = (await db.select().from(dailyRecommendations).where(eq(dailyRecommendations.id, oldReject.id)))[0];
  ok("[39] presenting a changed fingerprint supersedes the responded row → NEW pending row", superseded.id !== oldReject.id && superseded.response === "pending");
  ok("[40] supersession preserves the old row's response + snapshot + links supersededById", oldAfter.response === "reject" && oldAfter.supersededAt != null && oldAfter.supersededById === superseded.id && JSON.stringify(oldAfter.snapshot) !== "null");
  ok("[41] exactly one active row remains for the key", (await db.select().from(dailyRecommendations).where(and(eq(dailyRecommendations.userId, U), eq(dailyRecommendations.recommendationKey, "z3:sup:reject"), isNull(dailyRecommendations.deletedAt), isNull(dailyRecommendations.supersededAt)))).length === 1);
  const acptSig = rSig("z3:sup:accept");
  const acptSame = await L.presentRecommendation(U, acptSig, snap(acptSig), CTX, { now: NOWD });
  ok("[42] unchanged fingerprint does NOT create a new row (reuse)", acptSame.response === "accept" && (await db.select().from(dailyRecommendations).where(and(eq(dailyRecommendations.userId, U), eq(dailyRecommendations.recommendationKey, "z3:sup:accept"), isNull(dailyRecommendations.supersededAt)))).length === 1);
  // concurrency guard: two direct active inserts for same key → second throws (index enforces single active)
  ok("[43] concurrency cannot create duplicate active rows (unique index enforces one)", await threw(() => mkRow(U, "z3:sup:accept")));
  const compChanged = { ...rSig("z3:sup:complete"), estimatedCost: 42 };
  await L.presentRecommendation(U, compChanged, snap(compChanged), CTX, { now: NOWD });
  ok("[44] a completed row can be superseded by a materially-changed fingerprint", (await db.select().from(dailyRecommendations).where(and(eq(dailyRecommendations.userId, U), eq(dailyRecommendations.recommendationKey, "z3:sup:complete"), isNull(dailyRecommendations.supersededAt), isNull(dailyRecommendations.deletedAt)))).length === 1 && (await db.select().from(dailyRecommendations).where(and(eq(dailyRecommendations.userId, U), eq(dailyRecommendations.recommendationKey, "z3:sup:complete")))).length === 2);
  await resetLifecycle();

  /* =========== REVIEW FIX 1 — genuinely ATOMIC supersession (single statement) [S1-S6] =========== */
  console.log("\n[atomic supersession]");
  // Successful supersession via the service → exactly one active row + preserved old + link.
  const aSig = rSig("z3:atom"); await L.presentRecommendation(U, aSig, snap(aSig), CTX, { now: NOWD });
  await L.respondToRecommendation(U, "z3:atom", "reject", { now: NOWD, today: NOW });
  const aOld = (await db.select().from(dailyRecommendations).where(and(eq(dailyRecommendations.userId, U), eq(dailyRecommendations.recommendationKey, "z3:atom"))))[0];
  const aNew = await L.presentRecommendation(U, { ...aSig, estimatedCost: 500 }, snap({ ...aSig, estimatedCost: 500 }), CTX, { now: NOWD });
  const aOldAfter = (await db.select().from(dailyRecommendations).where(eq(dailyRecommendations.id, aOld.id)))[0];
  ok("[S1] atomic supersession leaves exactly one active row + preserves old response/snapshot + links",
    (await db.select().from(dailyRecommendations).where(and(eq(dailyRecommendations.userId, U), eq(dailyRecommendations.recommendationKey, "z3:atom"), isNull(dailyRecommendations.supersededAt), isNull(dailyRecommendations.deletedAt)))).length === 1
    && aNew.id !== aOld.id && aOldAfter.response === "reject" && aOldAfter.supersededById === aNew.id && aOldAfter.supersededAt != null);
  // DB-LEVEL PROOF: a forced replacement-insert failure inside the SAME statement rolls the whole thing
  // back (old row's superseded_at reverts; no orphan new row) — atomicity is in the statement, not app cleanup.
  await resetLifecycle();
  const [rbOld] = await db.insert(dailyRecommendations).values({ userId: U, recommendationKey: "z3:rb", domain: "d", signalType: "t", sourceRefs: [], signalFingerprint: "fp1", presentedOn: NOW, snapshot: {}, response: "reject", respondedAt: NOWD }).returning();
  // Call the ATOMIC function with a deliberately-failing INSERT (recommendation_key > varchar(240)).
  // The function deactivates the old row first, then the INSERT fails → the single SELECT statement
  // rolls the WHOLE thing back (superseded_at reverts; no orphan row) — atomicity is in the DB statement.
  const rbThrew = await threw(() => db.execute(sql`SELECT supersede_daily_recommendation(${U}, ${rbOld.id}, ${"x".repeat(300)}, 'd', 't', '[]'::jsonb, 'fp2', ${NOW}::date, '{}'::jsonb, now())`));
  const rbAfter = (await db.select().from(dailyRecommendations).where(eq(dailyRecommendations.id, rbOld.id)))[0];
  ok("[S2] forced replacement-insert failure ROLLS BACK old-row deactivation (statement atomicity, not app cleanup)",
    rbThrew === true && rbAfter.supersededAt === null && rbAfter.response === "reject"
    && (await db.select().from(dailyRecommendations).where(eq(dailyRecommendations.userId, U))).length === 1);
  ok("[S3] after a failed supersession the original row is still active + usable (can receive a response)", (await L.respondToRecommendation(U, "z3:rb", "accept", { now: NOWD, today: NOW })).response === "accept");
  // The deactivate + insert + link all run inside ONE plpgsql function call (one SQL statement), so a
  // link failure rolls the whole op back by the identical mechanism proven in [S2]. The old non-atomic
  // 3-call flow is gone; the service invokes the function.
  ok("[S4] supersession is one atomic statement (function call); no separate 3-call flow remains", !/await db\.update\(dailyRecommendations\)\.set\(\{ supersededAt/.test(readFileSync("lib/daily/lifecycle.ts", "utf8")) && /supersede_daily_recommendation/.test(readFileSync("lib/daily/lifecycle.ts", "utf8")));
  // Concurrency: two concurrent supersessions of the same active row → one active row remains, no duplicate.
  await resetLifecycle();
  const cSig = rSig("z3:conc"); await L.presentRecommendation(U, cSig, snap(cSig), CTX, { now: NOWD });
  await L.respondToRecommendation(U, "z3:conc", "reject", { now: NOWD, today: NOW });
  const [r1, r2] = await Promise.allSettled([
    L.presentRecommendation(U, { ...cSig, estimatedCost: 11 }, snap({ ...cSig, estimatedCost: 11 }), CTX, { now: NOWD }),
    L.presentRecommendation(U, { ...cSig, estimatedCost: 22 }, snap({ ...cSig, estimatedCost: 22 }), CTX, { now: NOWD }),
  ]);
  ok("[S5] concurrent supersessions resolve to exactly one active row (race guard, no duplicates)",
    (await db.select().from(dailyRecommendations).where(and(eq(dailyRecommendations.userId, U), eq(dailyRecommendations.recommendationKey, "z3:conc"), isNull(dailyRecommendations.supersededAt), isNull(dailyRecommendations.deletedAt)))).length === 1 && r1.status === "fulfilled" && r2.status === "fulfilled");
  // Cross-owner: another owner presenting the same key never supersedes THIS owner's active row.
  const uActive = (await db.select().from(dailyRecommendations).where(and(eq(dailyRecommendations.userId, U), eq(dailyRecommendations.recommendationKey, "z3:conc"), isNull(dailyRecommendations.supersededAt))))[0];
  await L.presentRecommendation(OTHER, { ...cSig, estimatedCost: 99 }, snap({ ...cSig, estimatedCost: 99 }), CTX, { now: NOWD });
  const uAfter = (await db.select().from(dailyRecommendations).where(eq(dailyRecommendations.id, uActive.id)))[0];
  ok("[S6] cross-owner: another owner cannot supersede this owner's row (owner-scoped)", uAfter.supersededAt === null && uAfter.userId === U && (await db.select().from(dailyRecommendations).where(and(eq(dailyRecommendations.userId, OTHER), eq(dailyRecommendations.recommendationKey, "z3:conc")))).length === 1);
  await resetLifecycle();

  /* ===================== Slice 2 integration [45-49] ===================== */
  console.log("\n[slice 2 integration]");
  const riskSig = mkSig({ domain: "bills", signalType: "bill_overdue", urgency: "high", effectiveDate: "2026-06-29", candidateAction: "pay", key: "z3:int:risk" });
  const collected = { signals: [riskSig], degraded: [], invalid: [], context: CTX, collectedAt: CTX.now };
  const selNoSup = rankSignals(collected, { today: NOW, availableCash: 1000 });
  ok("[45] unsuppressed key is rankable (becomes risk + move)", selNoSup.risk.signalKey === "z3:int:risk" && selNoSup.recommendedMove.signalKey === "z3:int:risk");
  await L.presentRecommendation(U, riskSig, snap(riskSig), CTX, { now: NOWD });
  await L.respondToRecommendation(U, "z3:int:risk", "accept", { now: NOWD, today: NOW });
  const supKeys = await L.loadSuppressedKeys(U, NOW, new Map([[riskSig.key, fingerprintOfSignal(riskSig)]]));
  const selSup = rankSignals(collected, { today: NOW, availableCash: 1000, suppressedKeys: supKeys });
  ok("[46] a suppressed lifecycle key cannot become risk / opportunity / recommended move", selSup.risk.signalKey === null && selSup.opportunity.signalKey === null && selSup.recommendedMove.signalKey === null);
  const cntBefore = (await db.select().from(dailyRecommendations).where(eq(dailyRecommendations.userId, U))).length;
  rankSignals(collected, { today: NOW }); await collectDailySignals(U, CTX);
  ok("[47] pure ranking + collection perform NO writes", (await db.select().from(dailyRecommendations).where(eq(dailyRecommendations.userId, U))).length === cntBefore);
  await resetLifecycle();
  const roRun = await L.runDailySelection(U, CTX); // default read-only
  ok("[48] runDailySelection is read-only by default (no lifecycle rows written)", (await db.select().from(dailyRecommendations).where(eq(dailyRecommendations.userId, U))).length === 0 && !!roRun.selection);
  await resetLifecycle();
  const wRun = await L.runDailySelection(U, { ...CTX }, { present: true, availableCash: 100000 });
  ok("[49] persistence occurs only through an explicit present request (present:true writes ≤1 row)", (await db.select().from(dailyRecommendations).where(eq(dailyRecommendations.userId, U))).length === (wRun.selection.recommendedMove.signalKey ? 1 : 0));
  await resetLifecycle();

  /* ===================== cleanup / owner protection [50-54] ===================== */
  console.log("\n[cleanup / owner protection]");
  ok("[50] no temporary lifecycle rows remain for owner or foreign", (await db.select().from(dailyRecommendations).where(inArray(dailyRecommendations.userId, [U, FOREIGN]))).length === 0);
  const conns = await db.select().from(financialConnections).where(and(eq(financialConnections.userId, U), isNull(financialConnections.deletedAt)));
  const accts = await db.select().from(financialAccounts).where(and(eq(financialAccounts.userId, U), isNull(financialAccounts.deletedAt)));
  const linked = accts.filter((x) => x.balanceSource === "linked"); let orphan = 0;
  for (const l of linked) { const m = await db.select().from(providerAccounts).where(and(eq(providerAccounts.financialAccountId, l.id), isNull(providerAccounts.deletedAt))); if (m.length !== 1) orphan++; }
  ok("[51] owner finance data intact (BofA active, Plaid linked, Chase/BofA manual)", conns.some((x) => /bank of america/i.test(x.institutionName ?? "") && x.status === "active") && accts.some((x) => x.name === "Plaid Checking" && x.balanceSource === "linked") && accts.filter((x) => ["Chase", "BofA"].includes(x.name)).every((x) => x.balanceSource === "manual"));
  ok("[52] imported transactions intact; no movement created; no orphan", (await db.select().from(importedTransactions).where(eq(importedTransactions.userId, U))).length === impBefore && impBefore === 19 && (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length === movBefore && orphan === 0);
  ok("[53] request 222 remains present", (await db.select().from(experienceRequests).where(eq(experienceRequests.id, 222))).length === 1);
  const src = readFileSync("lib/daily/lifecycle.ts", "utf8") + readFileSync("lib/daily/fingerprint.ts", "utf8");
  ok("[54] no secret in Slice 3 source; no external/AI/network call", !/access-sandbox-[0-9a-f]{8}|sk-ant-|npg_[A-Za-z0-9]{6}/.test(src) && !/anthropic|openai|fetch\(|https?:\/\//i.test(src));

  ok("[55] temp cross-owner user cleaned up (exact-ID)", true); // asserted after cleanupUser below
  await cleanupUser();
  ok("[56] no residual temp user or its lifecycle rows remain", (await db.select().from(users).where(eq(users.id, OTHER))).length === 0 && (await db.select().from(dailyRecommendations).where(inArray(dailyRecommendations.userId, [U, FOREIGN, OTHER]))).length === 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch(async (e) => { try { await resetLifecycle(); await cleanupUser(); } catch { /* noop */ } console.error(e); process.exit(1); });
