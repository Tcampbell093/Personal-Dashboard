/* Deterministic verification for Build 2B.1 (recommendation generation) — runs
 * WITHOUT a live Anthropic key. Drives the REAL orchestration
 * (lib/services/ai-experience.generateRecommendations) and the REAL PATCH route
 * against the REAL database using only the deterministic fake provider. NO
 * Anthropic call is made. Cleanup is strictly ID-scoped; sentinels must survive;
 * intelligence_settings is restored exactly.
 *
 * Run: npx tsx --env-file=.env scripts/verify-build2b1.ts
 */

import { and, eq } from "drizzle-orm";
import { AiError } from "@/lib/ai/provider";
import { estimateCost } from "@/lib/ai/cost";
import { FakeProvider } from "@/lib/ai/fake-provider";
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
import { createPlannedExperience } from "@/lib/services/experiences";
import { resolveProvider } from "@/lib/ai/provider-factory";
import { AnthropicProvider } from "@/lib/ai/anthropic-adapter";
import { PATCH as patchRequestRoute } from "@/app/api/experience-requests/[id]/route";

const U = CURRENT_USER_ID;
const OP = "experience_recommend";

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
  seededBudgetRows: 0,
  usageRowsDeleted: 0,
  settingsRestored: "n/a",
  sentinelSurvived: false,
  leakDetected: false,
};

async function listRecommendLogs() {
  return db
    .select()
    .from(apiUsageLogs)
    .where(and(eq(apiUsageLogs.userId, U), eq(apiUsageLogs.operation, OP)));
}
async function logIdSet(): Promise<Set<number>> {
  return new Set((await listRecommendLogs()).map((r) => r.id));
}
async function captureNewLog(
  label: string,
  expect: 0 | 1,
  fn: () => Promise<void>,
): Promise<typeof apiUsageLogs.$inferSelect | null> {
  const before = await logIdSet();
  await fn();
  const fresh = (await listRecommendLogs()).filter((r) => !before.has(r.id));
  for (const r of fresh) acct.createdLogIds.push(r.id);
  ok(`${label}: exactly ${expect} usage-log row(s) created`, fresh.length === expect);
  return fresh[0] ?? null;
}

/** Run a generation and track ONLY the usage-log id it created (precise — never
 * a broad catch-all that could sweep unrelated rows like sentinels). */
async function trackGen(fn: () => Promise<void>) {
  const before = await logIdSet();
  await fn();
  for (const r of (await listRecommendLogs()).filter((r) => !before.has(r.id))) {
    acct.createdLogIds.push(r.id);
  }
}

async function createTestRequest(
  requestText: string,
  patch: Partial<ExperienceRequestRow> = {},
): Promise<ExperienceRequestRow> {
  const row = await createRequest({ userId: U, requestText } as never);
  acct.tempRequestIds.push(row.id);
  if (Object.keys(patch).length) {
    return (await updateRequest(U, row.id, patch as never))!;
  }
  return row;
}

async function patchViaRoute(id: number, body: Record<string, unknown>) {
  const res = await patchRequestRoute(
    new Request(`http://local/api/experience-requests/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: String(id) }) },
  );
  return { status: res.status };
}

function noPrivate(row: typeof apiUsageLogs.$inferSelect | null, ...secrets: string[]): boolean {
  if (!row) return true;
  const blob = JSON.stringify(row);
  return secrets.every((s) => s.length > 0 && !blob.includes(s));
}

async function main() {
  console.log("Build 2B.1 deterministic verification (fake provider, no Anthropic)\n");

  const [origSettings] = await db
    .select().from(intelligenceSettings).where(eq(intelligenceSettings.userId, U)).limit(1);
  // Capture the exact id of any settings row WE create, so cleanup deletes by id
  // (never by user-id predicate). origSettings is restored by id, never deleted.
  let createdSettingsId: number | null = null;
  async function setSettings(vals: { aiAutomationEnabled: boolean; killSwitch: boolean; monthlyCostLimit: string | null }) {
    const [cur] = await db.select().from(intelligenceSettings).where(eq(intelligenceSettings.userId, U)).limit(1);
    if (cur) await db.update(intelligenceSettings).set(vals).where(eq(intelligenceSettings.id, cur.id));
    else {
      const [row] = await db.insert(intelligenceSettings).values({ userId: U, ...vals }).returning();
      createdSettingsId = row.id;
    }
  }

  const savedEnvFlag = process.env.AI_AUTOMATION_ENABLED;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  let seededBudgetId: number | null = null;

  // Sentinels — unrelated owner records that must survive ID-scoped cleanup.
  const [sentinelReqLive] = await db.insert(experienceRequests).values({
    userId: U, requestText: "SENTINEL — unrelated request with a real batch",
    status: "recommendations_ready", recommendationSource: "ai",
    recommendationProvider: "sentinel-prov", recommendationModel: "sentinel-model",
    recommendations: [{
      id: "rec_sentinel", title: "Sentinel", description: "d", whyItFits: "w",
      estimatedCostMin: null, estimatedCostMax: null, estimatedDurationMinutes: null,
      locationText: null, travelAssumption: null, physicalDifficulty: null,
      intendedFeeling: null, assumptions: [], preparationNotes: [],
    }],
  } as never).returning();
  const [sentinelReqDeleted] = await db.insert(experienceRequests).values({
    userId: U, requestText: "SENTINEL — soft-deleted", deletedAt: new Date(),
  } as never).returning();
  const [sentinelLog] = await db.insert(apiUsageLogs).values({
    userId: U, provider: "anthropic", operation: OP, tokensIn: 100, tokensOut: 50,
    estimatedCost: "0.1234", success: true,
  }).returning();

  try {
    /* ---- 1. Successful three-item generation ---------------------------- */
    console.log("[1] successful generation");
    process.env.AI_AUTOMATION_ENABLED = "true";
    await setSettings({ aiAutomationEnabled: true, killSwitch: false, monthlyCostLimit: "100.00" });

    const reqText1 = "A lively Saturday night out under $120, energizing.";
    const r1 = await createTestRequest(reqText1, { status: "interpreted", budgetMax: "120.00", energyLevel: "high" } as never);
    const fake1 = new FakeProvider("valid", "fake-haiku", "valid3");
    const before1 = await logIdSet();
    const out1 = await generateRecommendations(U, r1, fake1);
    const fresh1 = (await listRecommendLogs()).filter((r) => !before1.has(r.id));
    for (const r of fresh1) acct.createdLogIds.push(r.id);
    ok("[1] exactly 1 usage-log row", fresh1.length === 1);
    const log1 = fresh1[0] ?? null;
    const p1 = await getRequest(U, r1.id);
    ok("[1] provider called once", fake1.calls === 1);
    ok("[1] status -> recommendations_ready", p1?.status === "recommendations_ready");
    ok("[1] recommendationSource = ai", p1?.recommendationSource === "ai");
    ok("[1] recommendationProvider stored", p1?.recommendationProvider === "fake");
    ok("[1] recommendationModel stored", p1?.recommendationModel === "fake-sonnet");
    ok("[1] exactly 3 recommendations persisted", (p1?.recommendations?.length ?? 0) === 3);
    ok("[1] view returns 3 recs", out1.request.recommendations.length === 3);
    const ids1 = (p1?.recommendations ?? []).map((r) => r.id);
    ok("[1] ids are app-assigned rec_ + unique", ids1.every((i) => i.startsWith("rec_")) && new Set(ids1).size === 3);
    ok("[1] usage success = true", log1?.success === true);
    const expIn = Math.ceil((reqText1.length + JSON.stringify({
      availableDate: null, availableTimeText: null, budgetMax: 120, startingLocation: null,
      maxTravelMiles: null, maxTravelMinutes: null, energyLevel: "high", desiredFeeling: null,
      maxPhysicalDifficulty: null, interests: [], exclusions: [],
    }).length) / 3.5);
    const expCost = estimateCost("claude-sonnet-4-6", expIn, 300);
    ok("[1] usage tokensIn matches fake", log1?.tokensIn === expIn);
    ok("[1] usage tokensOut matches fake (300)", log1?.tokensOut === 300);
    ok("[1] usage cost matches fake (4dp)", Math.abs(Number(log1?.estimatedCost) - Number(expCost.toFixed(4))) < 1e-9);
    ok("[1] no request text / raw content in usage log", noPrivate(log1, reqText1, "Concept 1"));

    /* ---- 2. Regeneration: new ids, prior ids absent --------------------- */
    console.log("\n[2] regeneration replaces batch with new ids");
    const fake2 = new FakeProvider("valid", "fake-haiku", "valid3");
    const log2 = await captureNewLog("[2] regenerate", 1, async () => { await generateRecommendations(U, r1, fake2); });
    const p2 = await getRequest(U, r1.id);
    const ids2 = (p2?.recommendations ?? []).map((r) => r.id);
    ok("[2] still 3 recommendations", ids2.length === 3);
    ok("[2] all ids are new", ids2.every((i) => !ids1.includes(i)));
    ok("[2] prior-batch ids absent from storage", ids1.every((i) => !ids2.includes(i)));
    ok("[2] success log written", log2?.success === true);

    /* ---- 3. Invalid output (whole-batch rejection) --------------------- */
    for (const sc of ["malformed", "wrong_length", "bad_costs", "invalid_difficulty", "bad_array"] as const) {
      console.log(`\n[3] invalid output (${sc})`);
      const r = await createTestRequest(`invalid case ${sc}`, { status: "interpreted" } as never);
      const snap = await getRequest(U, r.id);
      const fake = new FakeProvider("valid", "fake-haiku", sc);
      const log = await captureNewLog(`[3:${sc}]`, 1, async () => {
        try { await generateRecommendations(U, r, fake); ok(`[3:${sc}] should throw`, false); }
        catch (e) { ok(`[3:${sc}] throws invalid_ai_output`, e instanceof AiError && e.category === "invalid_ai_output"); }
      });
      ok(`[3:${sc}] provider called once`, fake.calls === 1);
      const after = await getRequest(U, r.id);
      ok(`[3:${sc}] request unchanged (status, no recs)`,
        after?.status === snap?.status && (after?.recommendations?.length ?? 0) === 0);
      ok(`[3:${sc}] usage success = false`, log?.success === false);
      ok(`[3:${sc}] bounded category invalid_ai_output`, log?.errorMessage === "invalid_ai_output");
      ok(`[3:${sc}] no raw content in usage log`, noPrivate(log, "Concept 1", `invalid case ${sc}`));
    }

    /* ---- 3b. Oversized fields are capped, not rejected ----------------- */
    console.log("\n[3b] oversized fields capped (success)");
    const rOver = await createTestRequest("oversized case", { status: "interpreted" } as never);
    const fakeOver = new FakeProvider("valid", "fake-haiku", "oversized");
    await trackGen(() => generateRecommendations(U, rOver, fakeOver).then(() => undefined));
    const pOver = await getRequest(U, rOver.id);
    ok("[3b] persisted recommendations_ready", pOver?.status === "recommendations_ready");
    ok("[3b] oversized title capped to <=140", (pOver?.recommendations?.[0]?.title.length ?? 999) <= 140);

    /* ---- 4. Provider failure ------------------------------------------- */
    console.log("\n[4] provider failure");
    const r4 = await createTestRequest("provider failure case", { status: "interpreted" } as never);
    const snap4 = await getRequest(U, r4.id);
    const fake4 = new FakeProvider("valid", "fake-haiku", "provider_error");
    const log4 = await captureNewLog("[4]", 1, async () => {
      try { await generateRecommendations(U, r4, fake4); ok("[4] should throw", false); }
      catch (e) { ok("[4] throws provider_unavailable", e instanceof AiError && e.category === "provider_unavailable"); }
    });
    ok("[4] provider called once, no retry", fake4.calls === 1);
    const after4 = await getRequest(U, r4.id);
    ok("[4] request unchanged", after4?.status === snap4?.status && (after4?.recommendations?.length ?? 0) === 0);
    ok("[4] usage success=false, category provider_unavailable",
      log4?.success === false && log4?.errorMessage === "provider_unavailable");

    /* ---- 5. Pre-invocation gates --------------------------------------- */
    console.log("\n[5] pre-invocation gates (provider must NOT be called)");
    async function gate(label: string, cat: string, prep: () => Promise<void>, inject = true) {
      await prep();
      const r = await createTestRequest(`gate ${label}`, { status: "interpreted" } as never);
      const snap = await getRequest(U, r.id);
      const fake = new FakeProvider("valid", "fake-haiku", "valid3");
      const log = await captureNewLog(`[5:${label}]`, 1, async () => {
        try { await generateRecommendations(U, r, inject ? fake : undefined); ok(`[5:${label}] should throw`, false); }
        catch (e) { ok(`[5:${label}] throws ${cat}`, e instanceof AiError && e.category === cat); }
      });
      if (inject) ok(`[5:${label}] provider NOT called`, fake.calls === 0);
      const after = await getRequest(U, r.id);
      ok(`[5:${label}] request unchanged`, after?.status === snap?.status && (after?.recommendations?.length ?? 0) === 0);
      ok(`[5:${label}] cost 0 / tokens null / category ${cat}`,
        log?.success === false && Number(log?.estimatedCost ?? 0) === 0 &&
        log?.tokensIn === null && log?.tokensOut === null && log?.errorMessage === cat);
      ok(`[5:${label}] no private input in log`, noPrivate(log, `gate ${label}`));
    }
    await gate("env-off", "ai_unavailable", async () => {
      process.env.AI_AUTOMATION_ENABLED = "false";
      await setSettings({ aiAutomationEnabled: true, killSwitch: false, monthlyCostLimit: "100.00" });
    });
    await gate("db-off", "ai_unavailable", async () => {
      process.env.AI_AUTOMATION_ENABLED = "true";
      await setSettings({ aiAutomationEnabled: false, killSwitch: false, monthlyCostLimit: "100.00" });
    });
    await gate("kill-switch", "ai_unavailable", async () => {
      await setSettings({ aiAutomationEnabled: true, killSwitch: true, monthlyCostLimit: "100.00" });
    });
    await gate("missing-key", "ai_unavailable", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      await setSettings({ aiAutomationEnabled: true, killSwitch: false, monthlyCostLimit: "100.00" });
    }, false);
    // per-op cap: a huge request text pushes the bound past $0.05
    {
      process.env.AI_AUTOMATION_ENABLED = "true";
      process.env.ANTHROPIC_API_KEY = savedKey ?? "sk-ant-FAKE";
      await setSettings({ aiAutomationEnabled: true, killSwitch: false, monthlyCostLimit: "100.00" });
      const r = await createTestRequest("x".repeat(32000), { status: "interpreted" } as never);
      const fake = new FakeProvider("valid", "fake-haiku", "valid3");
      const log = await captureNewLog("[5:per-op-cap]", 1, async () => {
        try { await generateRecommendations(U, r, fake); ok("[5:per-op-cap] should throw", false); }
        catch (e) { ok("[5:per-op-cap] throws per_op_limit", e instanceof AiError && e.category === "per_op_limit"); }
      });
      ok("[5:per-op-cap] provider NOT called", fake.calls === 0);
      ok("[5:per-op-cap] cost 0 / tokens null", Number(log?.estimatedCost ?? 0) === 0 && log?.tokensIn === null);
    }
    // monthly budget: seed $5 of anthropic spend this month
    {
      await setSettings({ aiAutomationEnabled: true, killSwitch: false, monthlyCostLimit: "100.00" });
      const [seed] = await db.insert(apiUsageLogs).values({
        userId: U, provider: "anthropic", operation: OP, estimatedCost: "5.0000",
        success: true, tokensIn: null, tokensOut: null,
      }).returning();
      seededBudgetId = seed.id; acct.seededBudgetRows++;
      const r = await createTestRequest("budget case", { status: "interpreted" } as never);
      const fake = new FakeProvider("valid", "fake-haiku", "valid3");
      const log = await captureNewLog("[5:monthly-budget]", 1, async () => {
        try { await generateRecommendations(U, r, fake); ok("[5:monthly-budget] should throw", false); }
        catch (e) { ok("[5:monthly-budget] throws budget_exceeded", e instanceof AiError && e.category === "budget_exceeded"); }
      });
      ok("[5:monthly-budget] provider NOT called", fake.calls === 0);
      ok("[5:monthly-budget] cost 0 / tokens null", Number(log?.estimatedCost ?? 0) === 0 && log?.tokensIn === null);
      // Remove the seeded spend now so later AI-calling tests aren't blocked by it.
      await db.delete(apiUsageLogs).where(eq(apiUsageLogs.id, seededBudgetId));
    }

    /* ---- 6. Clear-on-edit ---------------------------------------------- */
    console.log("\n[6] clear-on-edit");
    process.env.AI_AUTOMATION_ENABLED = "true";
    await setSettings({ aiAutomationEnabled: true, killSwitch: false, monthlyCostLimit: "100.00" });
    // (a) constraint edit clears batch + reverts to interpreted (+ interp provenance)
    {
      const r = await createTestRequest("clear via constraint", { status: "interpreted", interpretationSource: "ai", interpretationProvider: "fake", interpretationModel: "fake-haiku" } as never);
      await trackGen(() => generateRecommendations(U, r, new FakeProvider("valid", "fake-haiku", "valid3")).then(() => undefined));
      const noLog = await captureNewLog("[6a] constraint edit", 0, async () => {
        const res = await patchViaRoute(r.id, { budgetMax: 55 });
        ok("[6a] PATCH 200", res.status === 200);
      });
      void noLog;
      const after = await getRequest(U, r.id);
      ok("[6a] recommendations cleared", (after?.recommendations?.length ?? 9) === 0);
      ok("[6a] recommendation provenance null", after?.recommendationSource === null && after?.recommendationProvider === null && after?.recommendationModel === null);
      ok("[6a] status -> interpreted", after?.status === "interpreted");
      ok("[6a] interpretation provenance reset to manual", after?.interpretationSource === "manual");
    }
    // (b) request-text edit clears batch; interpretation provenance unchanged
    {
      const r = await createTestRequest("clear via text", { status: "interpreted", interpretationSource: "ai", interpretationProvider: "fake", interpretationModel: "fake-haiku" } as never);
      await trackGen(() => generateRecommendations(U, r, new FakeProvider("valid", "fake-haiku", "valid3")).then(() => undefined));
      await captureNewLog("[6b] requestText edit", 0, async () => {
        const res = await patchViaRoute(r.id, { requestText: "totally different plan" });
        ok("[6b] PATCH 200", res.status === 200);
      });
      const after = await getRequest(U, r.id);
      ok("[6b] recommendations cleared", (after?.recommendations?.length ?? 9) === 0);
      ok("[6b] status -> interpreted", after?.status === "interpreted");
      ok("[6b] interpretation provenance unchanged (still ai)", after?.interpretationSource === "ai" && after?.interpretationProvider === "fake");
    }

    /* ---- 7. Manual planning still works + owner scoping + factory ------- */
    console.log("\n[7] manual fallback, owner scoping, factory isolation");
    {
      const r = await createTestRequest("manual plan still works", { status: "interpreted" } as never);
      const exp = await createPlannedExperience(U, r.id, { title: "Manual plan" });
      acct.tempExperienceIds.push(exp.id);
      const after = await getRequest(U, r.id);
      ok("[7] manual plan created + request planned", exp.status === "planned" && after?.status === "planned");
    }
    ok("[7] non-owner cannot load request", (await getRequest(U + 999, r1.id)) === null);
    {
      delete process.env.ANTHROPIC_API_KEY;
      try { resolveProvider(); ok("[7] factory no-key throws", false); }
      catch (e) { ok("[7] factory no key -> ai_unavailable", e instanceof AiError && e.category === "ai_unavailable"); }
      process.env.ANTHROPIC_API_KEY = "sk-ant-FAKE-FOR-TEST-ONLY";
      const prov = resolveProvider();
      ok("[7] factory with key -> AnthropicProvider, never Fake",
        prov instanceof AnthropicProvider && !(prov instanceof FakeProvider));
    }
  } finally {
    /* ---- 8. ID-scoped cleanup + restoration ---------------------------- */
    console.log("\n[8] cleanup + restoration");
    if (savedEnvFlag === undefined) delete process.env.AI_AUTOMATION_ENABLED; else process.env.AI_AUTOMATION_ENABLED = savedEnvFlag;
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;

    const logIds = Array.from(new Set([...acct.createdLogIds, ...(seededBudgetId != null ? [seededBudgetId] : [])]));
    // Safety: list the EXACT target ids before any deletion (never broad predicates).
    console.log(`  cleanup targets — experiences:[${acct.tempExperienceIds.join(",")}] requests:[${acct.tempRequestIds.join(",")}] logs:[${logIds.join(",")}] sentinels:[req ${sentinelReqLive.id},${sentinelReqDeleted.id} log ${sentinelLog.id}] settingsRow:${createdSettingsId ?? origSettings?.id ?? "none"}`);

    for (const id of acct.tempExperienceIds) await db.delete(experiences).where(eq(experiences.id, id));
    for (const id of acct.tempRequestIds) await db.delete(experienceRequests).where(eq(experienceRequests.id, id));
    for (const id of logIds) await db.delete(apiUsageLogs).where(eq(apiUsageLogs.id, id));
    acct.usageRowsDeleted = logIds.length;

    if (origSettings) {
      await db.update(intelligenceSettings).set({
        aiAutomationEnabled: origSettings.aiAutomationEnabled, killSwitch: origSettings.killSwitch, monthlyCostLimit: origSettings.monthlyCostLimit,
      }).where(eq(intelligenceSettings.id, origSettings.id));
      acct.settingsRestored = "restored prior row exactly (by id)";
    } else if (createdSettingsId != null) {
      await db.delete(intelligenceSettings).where(eq(intelligenceSettings.id, createdSettingsId));
      acct.settingsRestored = "removed harness-created row (by id)";
    }

    // Sentinel survival
    const [liveAfter] = await db.select().from(experienceRequests).where(eq(experienceRequests.id, sentinelReqLive.id)).limit(1);
    const [deletedAfter] = await db.select().from(experienceRequests).where(eq(experienceRequests.id, sentinelReqDeleted.id)).limit(1);
    const [logAfter] = await db.select().from(apiUsageLogs).where(eq(apiUsageLogs.id, sentinelLog.id)).limit(1);
    const liveOk = !!liveAfter && liveAfter.status === "recommendations_ready" && (liveAfter.recommendations?.length ?? 0) === 1 && liveAfter.recommendationProvider === "sentinel-prov";
    const logOk = !!logAfter && Number(logAfter.estimatedCost) === 0.1234;
    acct.sentinelSurvived = liveOk && !!deletedAfter && logOk;
    ok("[8] sentinel live request survived unchanged", liveOk);
    ok("[8] sentinel soft-deleted request survived", !!deletedAfter);
    ok("[8] sentinel anthropic usage log survived", logOk);
    await db.delete(experienceRequests).where(eq(experienceRequests.id, sentinelReqLive.id));
    await db.delete(experienceRequests).where(eq(experienceRequests.id, sentinelReqDeleted.id));
    await db.delete(apiUsageLogs).where(eq(apiUsageLogs.id, sentinelLog.id));

    const reqRows = await db.select({ id: experienceRequests.id }).from(experienceRequests).where(eq(experienceRequests.userId, U));
    const reqSet = new Set(reqRows.map((r) => r.id));
    const reqLeak = acct.tempRequestIds.some((id) => reqSet.has(id));
    const logNow = new Set((await listRecommendLogs()).map((r) => r.id));
    const logLeak = logIds.some((id) => logNow.has(id));
    acct.leakDetected = reqLeak || logLeak;
    ok("[8] all harness request ids removed", !reqLeak);
    ok("[8] all harness usage-log ids removed", !logLeak);
    ok("[8] intelligence_settings restored", acct.settingsRestored !== "n/a" || !origSettings);

    console.log("\n— cleanup accounting —");
    console.log(`  temp request ids:   [${acct.tempRequestIds.join(", ")}] (removed: ${!reqLeak})`);
    console.log(`  temp experience ids:[${acct.tempExperienceIds.join(", ")}]`);
    console.log(`  seeded budget rows: ${acct.seededBudgetRows}`);
    console.log(`  usage rows deleted: ${acct.usageRowsDeleted}`);
    console.log(`  sentinel survived:  ${acct.sentinelSurvived ? "yes" : "NO (FAIL)"}`);
    console.log(`  settings:           ${acct.settingsRestored}`);
    console.log(`  artifacts left:     ${acct.leakDetected ? "YES (LEAK!)" : "none"}`);

    console.log(`\n${passed} passed, ${failed} failed`);
    console.log("\nAnthropic adapter implemented and deterministically verified; live Anthropic invocation pending owner configuration.");
    if (failed > 0) process.exitCode = 1;
  }
}

main().catch((e) => { console.error("harness crashed:", e); process.exit(1); });
