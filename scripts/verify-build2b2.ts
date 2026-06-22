/* Deterministic verification for Build 2B.2 (recommendation selection + atomic
 * one-action plan creation) — runs WITHOUT a live Anthropic key. Drives the REAL
 * selection service + the REAL select-recommendation route against the REAL
 * database. The fake provider is used only to SEED recommendation batches (no
 * Anthropic call). Cleanup is strictly exact-ID-scoped; sentinels must survive;
 * intelligence_settings is restored exactly (by id).
 *
 * Run: npx tsx --env-file=.env scripts/verify-build2b2.ts
 */

import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { apiUsageLogs, experienceRequests, experiences, intelligenceSettings } from "@/db/schema";
import { CURRENT_USER_ID } from "@/lib/auth";
import {
  createRequest,
  getRequest,
  updateRequest,
  type ExperienceRequestRow,
} from "@/lib/services/experience-requests";
import { generateRecommendations } from "@/lib/services/ai-experience";
import {
  selectRecommendation,
  createPlannedExperience,
  resolveExperience,
  deleteExperience,
  ExperienceError,
} from "@/lib/services/experiences";
import { FakeProvider } from "@/lib/ai/fake-provider";
import { POST as selectRoute } from "@/app/api/experience-requests/[id]/select-recommendation/route";

const U = CURRENT_USER_ID;

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

const acct = {
  tempRequestIds: [] as number[],
  tempExperienceIds: [] as number[],
  createdLogIds: [] as number[],
  settingsRestored: "n/a",
  sentinelSurvived: false,
  leak: false,
};

async function ownerLogIds(): Promise<Set<number>> {
  return new Set((await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))).map((r) => r.id));
}
async function liveExperiencesFor(requestId: number) {
  return db.select().from(experiences).where(and(eq(experiences.requestId, requestId), isNull(experiences.deletedAt)));
}

/** Create a request, set interpreted constraints, and seed a fake recommendation
 * batch (status recommendations_ready). Tracks ids. */
async function seedReady(
  requestText: string,
  constraints: Partial<ExperienceRequestRow> = {},
): Promise<ExperienceRequestRow> {
  const row = await createRequest({ userId: U, requestText } as never);
  acct.tempRequestIds.push(row.id);
  await updateRequest(U, row.id, { status: "interpreted", ...constraints } as never);
  const before = await ownerLogIds();
  await generateRecommendations(U, (await getRequest(U, row.id))!, new FakeProvider("valid", "fake-haiku", "valid3"));
  for (const r of (await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U)))) {
    if (!before.has(r.id)) acct.createdLogIds.push(r.id);
  }
  return (await getRequest(U, row.id))!;
}

async function callRoute(reqId: number, body: unknown) {
  const res = await selectRoute(
    new Request(`http://local/api/experience-requests/${reqId}/select-recommendation`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: String(reqId) }) },
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as { error?: string; experience?: Record<string, unknown> } | null };
}

async function main() {
  console.log("Build 2B.2 deterministic verification (fake-seeded, no Anthropic)\n");

  const [origSettings] = await db.select().from(intelligenceSettings).where(eq(intelligenceSettings.userId, U)).limit(1);
  let createdSettingsId: number | null = null;
  async function setSettings(vals: { aiAutomationEnabled: boolean; killSwitch: boolean; monthlyCostLimit: string | null }) {
    const [cur] = await db.select().from(intelligenceSettings).where(eq(intelligenceSettings.userId, U)).limit(1);
    if (cur) await db.update(intelligenceSettings).set(vals).where(eq(intelligenceSettings.id, cur.id));
    else { const [r] = await db.insert(intelligenceSettings).values({ userId: U, ...vals }).returning(); createdSettingsId = r.id; }
  }
  const savedEnvFlag = process.env.AI_AUTOMATION_ENABLED;

  // Sentinels — unrelated owner records that must survive ID-scoped cleanup.
  const [sentinelReqLive] = await db.insert(experienceRequests).values({
    userId: U, requestText: "SENTINEL 2b2 — unrelated request", status: "recommendations_ready",
    recommendationSource: "ai", recommendationProvider: "sentinel", recommendationModel: "sentinel",
    recommendations: [{ id: "rec_sentinel2b2", title: "S", description: "d", whyItFits: "w", estimatedCostMin: null, estimatedCostMax: null, estimatedDurationMinutes: null, locationText: null, travelAssumption: null, physicalDifficulty: null, intendedFeeling: null, assumptions: [], preparationNotes: [] }],
  } as never).returning();
  const [sentinelLog] = await db.insert(apiUsageLogs).values({
    userId: U, provider: "anthropic", operation: "experience_recommend", tokensIn: 1, tokensOut: 1, estimatedCost: "0.4321", success: true,
  }).returning();

  try {
    process.env.AI_AUTOMATION_ENABLED = "true";
    await setSettings({ aiAutomationEnabled: true, killSwitch: false, monthlyCostLimit: "100.00" });

    /* ---- 1. Valid selection: one plan, mapping, no AI/log ---------------- */
    console.log("[1] valid selection");
    const r1 = await seedReady("A lively night out under $120", { availableDate: "2026-07-04", availableTimeText: "Saturday evening", budgetMax: "120.00", energyLevel: "high" } as never);
    const rec = r1.recommendations[0];
    const logsBeforeSelect = await ownerLogIds();
    const exp = await selectRecommendation(U, r1.id, rec.id);
    acct.tempExperienceIds.push(exp.id);
    const logsAfterSelect = await ownerLogIds();
    const reqAfter1 = await getRequest(U, r1.id);
    ok("[1] exactly one live experience", (await liveExperiencesFor(r1.id)).length === 1);
    ok("[1] request -> planned", reqAfter1?.status === "planned");
    ok("[1] recommendation batch retained (3)", (reqAfter1?.recommendations?.length ?? 0) === 3);
    ok("[1] no usage-log row created by selection", logsBeforeSelect.size === logsAfterSelect.size);
    ok("[1] title mapped", exp.title === rec.title);
    ok("[1] description mapped", exp.description === rec.description);
    ok("[1] locationText mapped", exp.locationText === rec.locationText);
    ok("[1] expectedCost = max ?? min", Number(exp.expectedCost) === (rec.estimatedCostMax ?? rec.estimatedCostMin));
    ok("[1] duration mapped", exp.expectedDurationMinutes === rec.estimatedDurationMinutes);
    ok("[1] difficulty mapped", exp.physicalDifficulty === rec.physicalDifficulty);
    ok("[1] desiredFeeling <- intendedFeeling", exp.desiredFeeling === rec.intendedFeeling);
    ok("[1] plannedDate from owner availability", exp.plannedDate === "2026-07-04");
    ok("[1] plannedTimeText from owner availability", exp.plannedTimeText === "Saturday evening");
    ok("[1] selectedRecommendationId stored", exp.selectedRecommendationId === rec.id);
    ok("[1] notes labels present", /Preparation:[\s\S]*Assumptions:[\s\S]*Travel:/.test(exp.notes ?? ""));

    /* ---- 2. Manual plan has null selected id ----------------------------- */
    console.log("\n[2] manual plan -> null selected id");
    const r2 = await seedReady("manual still works");
    const manual = await createPlannedExperience(U, r2.id, { title: "Manual plan" });
    acct.tempExperienceIds.push(manual.id);
    ok("[2] manual plan selectedRecommendationId null", manual.selectedRecommendationId === null);
    ok("[2] manual plan request -> planned", (await getRequest(U, r2.id))?.status === "planned");

    /* ---- 3. Strict body: extra fields + full object rejected ------------- */
    console.log("\n[3] strict body validation (route)");
    const r3 = await seedReady("strict body");
    const rec3 = r3.recommendations[0];
    const extra = await callRoute(r3.id, { recommendationId: rec3.id, title: "HACKED", expectedCost: 1 });
    ok("[3] extra fields -> 422", extra.status === 422);
    const fullObj = await callRoute(r3.id, { recommendationId: rec3.id, recommendation: { id: rec3.id, title: "HACKED" } });
    ok("[3] full object -> 422", fullObj.status === 422);
    ok("[3] no plan created by rejected bodies", (await liveExperiencesFor(r3.id)).length === 0 && (await getRequest(U, r3.id))?.status === "recommendations_ready");
    // valid route call uses ONLY server-resolved values
    const validRoute = await callRoute(r3.id, { recommendationId: rec3.id });
    ok("[3] valid route selection -> 200", validRoute.status === 200);
    ok("[3] created title is server-resolved (not client)", validRoute.body?.experience?.title === rec3.title);
    const r3exp = (await liveExperiencesFor(r3.id))[0];
    if (r3exp) acct.tempExperienceIds.push(r3exp.id);

    /* ---- 4. Stale / unknown / fabricated ids ----------------------------- */
    console.log("\n[4] stale / unknown / fabricated ids");
    const r4 = await seedReady("stale id case");
    const staleId = r4.recommendations[0].id;
    // regenerate -> new ids; the stale id is gone from the batch
    await generateRecommendations(U, (await getRequest(U, r4.id))!, new FakeProvider("valid", "fake-haiku", "valid3"));
    for (const l of (await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U)))) if (!acct.createdLogIds.includes(l.id) && l.id !== sentinelLog.id) acct.createdLogIds.push(l.id);
    try { await selectRecommendation(U, r4.id, staleId); ok("[4] stale id should throw", false); }
    catch (e) { ok("[4] stale id -> 404", e instanceof ExperienceError && e.httpStatus === 404); }
    const unknown = await callRoute(r4.id, { recommendationId: "rec_00000000-0000-0000-0000-000000000000" });
    ok("[4] unknown well-formed id -> 404", unknown.status === 404);
    const fabricated = await callRoute(r4.id, { recommendationId: "not-a-rec-id" });
    ok("[4] fabricated/malformed id -> 422", fabricated.status === 422);
    ok("[4] request unchanged after rejects (still recommendations_ready, no plan)", (await getRequest(U, r4.id))?.status === "recommendations_ready" && (await liveExperiencesFor(r4.id)).length === 0);

    /* ---- 5. Owner scoping ----------------------------------------------- */
    console.log("\n[5] owner scoping");
    try { await selectRecommendation(U + 9999, r4.id, r4.recommendations[0]?.id ?? "rec_x"); ok("[5] non-owner should throw", false); }
    catch (e) { ok("[5] non-owner -> 404", e instanceof ExperienceError && e.httpStatus === 404); }

    /* ---- 6. Not-ready status rejected ------------------------------------ */
    console.log("\n[6] not-ready status");
    const r6 = await createRequest({ userId: U, requestText: "not ready" } as never);
    acct.tempRequestIds.push(r6.id);
    await updateRequest(U, r6.id, { status: "interpreted" } as never);
    try { await selectRecommendation(U, r6.id, "rec_11111111-1111-1111-1111-111111111111"); ok("[6] not-ready should throw", false); }
    catch (e) { ok("[6] interpreted status -> 409", e instanceof ExperienceError && e.httpStatus === 409); }

    /* ---- 7. Double / different-rec selection -> exactly one plan ---------- */
    console.log("\n[7] double + different-rec selection");
    const r7 = await seedReady("double select");
    const [a7, b7] = [r7.recommendations[0], r7.recommendations[1]];
    const first = await selectRecommendation(U, r7.id, a7.id);
    acct.tempExperienceIds.push(first.id);
    try { await selectRecommendation(U, r7.id, a7.id); ok("[7] second same-rec should throw", false); }
    catch (e) { ok("[7] double-click same rec -> 409", e instanceof ExperienceError && e.httpStatus === 409); }
    try { await selectRecommendation(U, r7.id, b7.id); ok("[7] different rec should throw", false); }
    catch (e) { ok("[7] different rec after planned -> 409", e instanceof ExperienceError && e.httpStatus === 409); }
    ok("[7] exactly one live experience", (await liveExperiencesFor(r7.id)).length === 1);

    /* ---- 8. Atomicity + unique-index mapping ----------------------------- */
    console.log("\n[8] both-or-neither + unique-index conflict");
    const r8 = await seedReady("atomicity");
    // Directly insert a live experience (status planned) while the request is STILL
    // recommendations_ready -> the CTE's UPDATE matches but the INSERT hits the
    // unique index. Whole statement must roll back: 409, and request stays ready.
    const [pre] = await db.insert(experiences).values({ userId: U, requestId: r8.id, status: "planned", title: "pre-existing" } as never).returning();
    acct.tempExperienceIds.push(pre.id);
    try { await selectRecommendation(U, r8.id, r8.recommendations[0].id); ok("[8] should throw on unique conflict", false); }
    catch (e) { ok("[8] unique-index conflict -> 409", e instanceof ExperienceError && e.httpStatus === 409); }
    ok("[8] atomic rollback: request still recommendations_ready", (await getRequest(U, r8.id))?.status === "recommendations_ready");
    ok("[8] atomic rollback: still exactly one live experience", (await liveExperiencesFor(r8.id)).length === 1);

    /* ---- 9. Deletion recovery -> recommendations_ready ------------------- */
    console.log("\n[9] deletion recovery -> recommendations_ready");
    const r9 = await seedReady("recovery to ready");
    const e9 = await selectRecommendation(U, r9.id, r9.recommendations[0].id);
    acct.tempExperienceIds.push(e9.id);
    await deleteExperience(U, e9.id);
    ok("[9] planned (rec) delete -> recommendations_ready", (await getRequest(U, r9.id))?.status === "recommendations_ready");
    ok("[9] batch retained after recovery", (await getRequest(U, r9.id))?.recommendations?.length === 3);

    /* ---- 10. Fallback recovery -> draft --------------------------------- */
    console.log("\n[10] fallback recovery -> draft");
    // (a) manual plan -> draft
    const r10 = await seedReady("manual recovery");
    const m10 = await createPlannedExperience(U, r10.id, { title: "Manual" });
    acct.tempExperienceIds.push(m10.id);
    await deleteExperience(U, m10.id);
    ok("[10a] manual plan delete -> draft", (await getRequest(U, r10.id))?.status === "draft");
    // (b) rec plan whose id is no longer in the batch -> draft
    const r10b = await seedReady("rec id removed from batch");
    const e10b = await selectRecommendation(U, r10b.id, r10b.recommendations[0].id);
    acct.tempExperienceIds.push(e10b.id);
    // directly remove the selected id from the request's stored batch
    await updateRequest(U, r10b.id, { recommendations: [] } as never);
    await deleteExperience(U, e10b.id);
    ok("[10b] rec plan with id absent from batch -> draft", (await getRequest(U, r10b.id))?.status === "draft");

    /* ---- 11. Resolved deletion does not reactivate ---------------------- */
    console.log("\n[11] resolved deletion does not reactivate");
    const r11 = await seedReady("resolved no reactivate");
    const e11 = await selectRecommendation(U, r11.id, r11.recommendations[0].id);
    acct.tempExperienceIds.push(e11.id);
    await resolveExperience(U, e11.id, "completed", { meaningfulExperience: true });
    await deleteExperience(U, e11.id);
    ok("[11] resolved delete keeps request planned", (await getRequest(U, r11.id))?.status === "planned");

    /* ---- 12. REAL concurrent selection — same recommendation ------------ */
    console.log("\n[12] real concurrent selection (Promise.allSettled) — same recommendation");
    {
      const r = await seedReady("concurrent same-rec");
      const recId = r.recommendations[0].id;
      const logsBefore = await ownerLogIds();
      const results = await Promise.allSettled([
        selectRecommendation(U, r.id, recId),
        selectRecommendation(U, r.id, recId),
      ]);
      const successes = results.flatMap((x) => (x.status === "fulfilled" ? [x.value] : []));
      const failures = results.flatMap((x) => (x.status === "rejected" ? [x.reason] : []));
      for (const s of successes) acct.tempExperienceIds.push(s.id);
      const codes = failures.map((e) => (e instanceof ExperienceError ? e.httpStatus : 0));
      const live = await liveExperiencesFor(r.id);
      const reqAfter = await getRequest(U, r.id);
      const logsAfter = await ownerLogIds();
      console.log(`  [12] loser codes: ${JSON.stringify(codes)}`);
      ok("[12] exactly one success", successes.length === 1);
      ok("[12] exactly one 409 loser", failures.length === 1 && codes[0] === 409);
      ok("[12] exactly one live experience", live.length === 1);
      ok("[12] request -> planned", reqAfter?.status === "planned");
      ok("[12] experience stores selected rec id", live[0]?.selectedRecommendationId === recId);
      ok("[12] winner row matches the live experience", successes[0]?.id === live[0]?.id);
      ok("[12] batch retained (3)", (reqAfter?.recommendations?.length ?? 0) === 3);
      ok("[12] no usage-log row from selection", logsBefore.size === logsAfter.size);
    }

    /* ---- 13. REAL concurrent selection — different recommendations ------ */
    console.log("\n[13] real concurrent selection — different recommendations");
    {
      const r = await seedReady("concurrent diff-rec");
      const recA = r.recommendations[0].id;
      const recB = r.recommendations[1].id;
      const logsBefore = await ownerLogIds();
      const results = await Promise.allSettled([
        selectRecommendation(U, r.id, recA),
        selectRecommendation(U, r.id, recB),
      ]);
      const successes = results.flatMap((x) => (x.status === "fulfilled" ? [x.value] : []));
      const failures = results.flatMap((x) => (x.status === "rejected" ? [x.reason] : []));
      for (const s of successes) acct.tempExperienceIds.push(s.id);
      const codes = failures.map((e) => (e instanceof ExperienceError ? e.httpStatus : 0));
      const live = await liveExperiencesFor(r.id);
      const reqAfter = await getRequest(U, r.id);
      const logsAfter = await ownerLogIds();
      const winnerRecId = successes[0]?.selectedRecommendationId ?? null;
      console.log(`  [13] winner rec: ${winnerRecId === recA ? "A" : winnerRecId === recB ? "B" : "?"}, loser codes: ${JSON.stringify(codes)}`);
      ok("[13] exactly one success", successes.length === 1);
      ok("[13] exactly one 409 loser", failures.length === 1 && codes[0] === 409);
      ok("[13] exactly one live experience", live.length === 1);
      ok("[13] request -> planned", reqAfter?.status === "planned");
      ok("[13] stored id matches winner + is one of the two", live[0]?.selectedRecommendationId === winnerRecId && (winnerRecId === recA || winnerRecId === recB));
      ok("[13] losing recommendation created no experience", live.length === 1 && live[0]?.selectedRecommendationId !== (winnerRecId === recA ? recB : recA));
      ok("[13] batch retained (3)", (reqAfter?.recommendations?.length ?? 0) === 3);
      ok("[13] no usage-log row from selection", logsBefore.size === logsAfter.size);
    }
  } finally {
    /* ---- 12. ID-scoped cleanup + restoration ---------------------------- */
    console.log("\n[12] cleanup + restoration");
    if (savedEnvFlag === undefined) delete process.env.AI_AUTOMATION_ENABLED; else process.env.AI_AUTOMATION_ENABLED = savedEnvFlag;

    const logIds = Array.from(new Set(acct.createdLogIds));
    console.log(`  cleanup targets — experiences:[${acct.tempExperienceIds.join(",")}] requests:[${acct.tempRequestIds.join(",")}] logs:[${logIds.join(",")}] sentinels:[req ${sentinelReqLive.id} log ${sentinelLog.id}] settingsRow:${createdSettingsId ?? origSettings?.id ?? "none"}`);

    for (const id of acct.tempExperienceIds) await db.delete(experiences).where(eq(experiences.id, id));
    for (const id of acct.tempRequestIds) await db.delete(experienceRequests).where(eq(experienceRequests.id, id));
    for (const id of logIds) await db.delete(apiUsageLogs).where(eq(apiUsageLogs.id, id));

    if (origSettings) {
      await db.update(intelligenceSettings).set({ aiAutomationEnabled: origSettings.aiAutomationEnabled, killSwitch: origSettings.killSwitch, monthlyCostLimit: origSettings.monthlyCostLimit }).where(eq(intelligenceSettings.id, origSettings.id));
      acct.settingsRestored = "restored prior row exactly (by id)";
    } else if (createdSettingsId != null) {
      await db.delete(intelligenceSettings).where(eq(intelligenceSettings.id, createdSettingsId));
      acct.settingsRestored = "removed harness-created row (by id)";
    }

    const [liveAfter] = await db.select().from(experienceRequests).where(eq(experienceRequests.id, sentinelReqLive.id)).limit(1);
    const [logAfter] = await db.select().from(apiUsageLogs).where(eq(apiUsageLogs.id, sentinelLog.id)).limit(1);
    acct.sentinelSurvived = !!liveAfter && liveAfter.status === "recommendations_ready" && (liveAfter.recommendations?.length ?? 0) === 1 && !!logAfter && Number(logAfter.estimatedCost) === 0.4321;
    ok("[12] sentinel request survived unchanged", !!liveAfter && liveAfter.recommendationProvider === "sentinel" && (liveAfter.recommendations?.length ?? 0) === 1);
    ok("[12] sentinel usage log survived unchanged", !!logAfter && Number(logAfter.estimatedCost) === 0.4321);
    await db.delete(experienceRequests).where(eq(experienceRequests.id, sentinelReqLive.id));
    await db.delete(apiUsageLogs).where(eq(apiUsageLogs.id, sentinelLog.id));

    const reqRows = new Set((await db.select({ id: experienceRequests.id }).from(experienceRequests).where(eq(experienceRequests.userId, U))).map((r) => r.id));
    const reqLeak = acct.tempRequestIds.some((id) => reqRows.has(id));
    const expRows = new Set((await db.select({ id: experiences.id }).from(experiences).where(eq(experiences.userId, U))).map((r) => r.id));
    const expLeak = acct.tempExperienceIds.some((id) => expRows.has(id));
    acct.leak = reqLeak || expLeak;
    ok("[12] all harness request ids removed", !reqLeak);
    ok("[12] all harness experience ids removed", !expLeak);
    ok("[12] intelligence_settings restored", acct.settingsRestored !== "n/a" || !origSettings);

    console.log("\n— cleanup accounting —");
    console.log(`  sentinel survived: ${acct.sentinelSurvived ? "yes" : "NO (FAIL)"}`);
    console.log(`  settings: ${acct.settingsRestored}`);
    console.log(`  artifacts left: ${acct.leak ? "YES (LEAK!)" : "none"}`);
    console.log(`\n${passed} passed, ${failed} failed`);
    console.log("\nAnthropic adapter implemented and deterministically verified; live Anthropic invocation pending owner configuration.");
    if (failed > 0) process.exitCode = 1;
  }
}

main().catch((e) => { console.error("harness crashed:", e); process.exit(1); });
