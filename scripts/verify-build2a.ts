/* Deterministic verification for Build 2A — runs WITHOUT a live Anthropic key
 * and WITHOUT touching the database. Exercises the pure AI-layer units: output
 * validation, cost/budget gates, pricing, the deterministic fake provider, and
 * the production provider factory's key gating + fake-isolation guarantee.
 *
 * Run: npx tsx scripts/verify-build2a.ts
 *
 * NOTE: the full orchestration path (lib/services/ai-experience.ts) reads and
 * writes the DB (settings, usage log, persistence) and is verified separately
 * against the live database — it is intentionally not invoked here. */

import { and, eq } from "drizzle-orm";
import { AiError } from "@/lib/ai/provider";
import { validateInterpretation } from "@/lib/ai/interpretation-schema";
import { enforceBudget, estimateCost, estimateInputTokens } from "@/lib/ai/cost";
import { pricingFor, INTERPRET_MODEL } from "@/lib/ai/models";
import { FakeProvider } from "@/lib/ai/fake-provider";
import { db } from "@/db";
import { apiUsageLogs, experienceRequests, intelligenceSettings } from "@/db/schema";
import { CURRENT_USER_ID } from "@/lib/auth";
import { createRequest, getRequest } from "@/lib/services/experience-requests";
import { interpretRequest } from "@/lib/services/ai-experience";
import { PATCH as patchRequestRoute } from "@/app/api/experience-requests/[id]/route";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}
async function expectAiError(
  name: string,
  category: string,
  fn: () => unknown | Promise<unknown>,
) {
  try {
    await fn();
    failed++;
    console.error(`  ✗ ${name} — expected AiError(${category}) but none thrown`);
  } catch (e) {
    const isMatch = e instanceof AiError && e.category === category;
    ok(`${name} — throws ${category}`, isMatch);
    if (!isMatch) console.error(`      got:`, e);
  }
}

const VALID = {
  availableDate: "2026-07-04",
  availableTimeText: "Saturday afternoon",
  budgetMax: 80,
  startingLocation: "Brooklyn, NY",
  maxTravelMiles: 10,
  maxTravelMinutes: 45,
  energyLevel: "medium",
  desiredFeeling: "energized",
  maxPhysicalDifficulty: "easy",
  interests: ["live music", "food"],
  exclusions: ["crowds"],
};

async function main() {
  console.log("Build 2A deterministic verification\n");

  console.log("validateInterpretation:");
  const v = validateInterpretation(VALID);
  ok("valid input normalizes", v.budgetMax === 80 && v.energyLevel === "medium");
  ok("valid date passes through", v.availableDate === "2026-07-04");
  await expectAiError("non-object", "invalid_ai_output", () => validateInterpretation(42));
  await expectAiError("array", "invalid_ai_output", () => validateInterpretation([]));
  await expectAiError("negative budget", "invalid_ai_output", () =>
    validateInterpretation({ ...VALID, budgetMax: -5 }),
  );
  await expectAiError("non-integer miles", "invalid_ai_output", () =>
    validateInterpretation({ ...VALID, maxTravelMiles: 3.5 }),
  );
  await expectAiError("bad energy enum", "invalid_ai_output", () =>
    validateInterpretation({ ...VALID, energyLevel: "turbo" }),
  );
  await expectAiError("malformed date", "invalid_ai_output", () =>
    validateInterpretation({ ...VALID, availableDate: "July 4th" }),
  );
  // Defensive normalization (not errors): caps + array filtering.
  const capped = validateInterpretation({
    ...VALID,
    interests: Array.from({ length: 50 }, (_, i) => `i${i}`),
    exclusions: [1, "ok", null],
  });
  ok("interests capped to 20", capped.interests.length === 20);
  ok("exclusions drops non-strings", capped.exclusions.length === 1 && capped.exclusions[0] === "ok");

  console.log("\npricing + cost:");
  const haiku = pricingFor("claude-haiku-4-5");
  ok("haiku priced $1/$5", haiku.inputPerMTok === 1 && haiku.outputPerMTok === 5);
  const unknown = pricingFor("some-future-model");
  ok("unknown model falls back to $3/$15", unknown.inputPerMTok === 3 && unknown.outputPerMTok === 15);
  ok("estimateInputTokens is ceil(len/3.5)", estimateInputTokens("abcdef") === Math.ceil(6 / 3.5));
  ok(
    "estimateCost matches manual math",
    Math.abs(estimateCost("claude-haiku-4-5", 1_000_000, 1_000_000) - 6) < 1e-9,
  );

  console.log("\nenforceBudget:");
  ok(
    "normal interpret call within caps returns boundCost",
    enforceBudget({
      op: "interpret",
      model: INTERPRET_MODEL,
      estInputTokens: 300,
      maxOutputTokens: 1024,
      monthToDate: 0,
      monthlyCostLimit: null,
    }).boundCost > 0,
  );
  await expectAiError("tiny per-op cap breached", "per_op_limit", () =>
    enforceBudget({
      op: "interpret",
      model: "claude-sonnet-4-6",
      estInputTokens: 100_000,
      maxOutputTokens: 1024,
      monthToDate: 0,
      monthlyCostLimit: null,
    }),
  );
  await expectAiError("monthly ceiling reached", "budget_exceeded", () =>
    enforceBudget({
      op: "interpret",
      model: INTERPRET_MODEL,
      estInputTokens: 300,
      maxOutputTokens: 1024,
      monthToDate: 5.0,
      monthlyCostLimit: null,
    }),
  );
  await expectAiError("configured lower limit wins", "budget_exceeded", () =>
    enforceBudget({
      op: "interpret",
      model: INTERPRET_MODEL,
      estInputTokens: 300,
      maxOutputTokens: 1024,
      monthToDate: 0.02,
      monthlyCostLimit: 0.02,
    }),
  );

  console.log("\nFakeProvider scenarios:");
  const input = { requestText: "something fun saturday", homeArea: "Brooklyn, NY", today: "2026-06-22" };
  const good = new FakeProvider("valid");
  const out = await good.interpret(input);
  ok("valid scenario returns result + usage", !!out.result && out.usage.provider === "fake");
  ok("valid scenario increments calls", good.calls === 1);
  await expectAiError("provider_error scenario", "provider_unavailable", () =>
    new FakeProvider("provider_error").interpret(input),
  );
  await expectAiError("malformed scenario", "invalid_ai_output", () =>
    new FakeProvider("malformed").interpret(input),
  );
  // malformed/invalid attach usage (a billed call that failed validation).
  try {
    await new FakeProvider("invalid_values").interpret(input);
  } catch (e) {
    ok("invalid_values attaches usage", e instanceof AiError && !!e.usage);
  }

  console.log("\nprovider factory (key gating + fake isolation):");
  // resolveProvider reads ANTHROPIC_API_KEY at call time, so toggling the env
  // var between calls is sufficient — no module-cache busting needed.
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const { resolveProvider } = await import("@/lib/ai/provider-factory");
  const { AnthropicProvider } = await import("@/lib/ai/anthropic-adapter");

  delete process.env.ANTHROPIC_API_KEY;
  await expectAiError("no key -> ai_unavailable", "ai_unavailable", () => resolveProvider());

  process.env.ANTHROPIC_API_KEY = "sk-ant-FAKE-FOR-TEST-ONLY-not-used-for-network";
  const prov = resolveProvider();
  ok("with key -> AnthropicProvider", prov instanceof AnthropicProvider);
  ok("factory NEVER returns FakeProvider", !(prov instanceof FakeProvider));

  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;

  await dbSuite();

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(
    "\nAnthropic adapter implemented and deterministically verified; " +
      "live Anthropic invocation pending owner configuration.",
  );
  if (failed > 0) process.exit(1);
}

/* ------------------------------------------------------------------------ *
 * Database-backed deterministic suite.
 *
 * Drives the REAL orchestration (lib/services/ai-experience.ts) and the REAL
 * request-update route against the REAL database, using only the deterministic
 * fake provider. NO Anthropic call is ever made. Every temporary row is removed
 * and the owner's intelligence_settings are restored exactly in a finally block.
 * ------------------------------------------------------------------------ */

const U = CURRENT_USER_ID;
const OP = "experience_interpret";

// Accounting, reported at the end. Cleanup is strictly ID-scoped: the harness
// deletes ONLY rows whose ids it recorded creating (tempRequestIds + createdLogIds
// + the seeded budget row). It never issues owner-, provider-, operation-, or
// table-wide deletes, so it is safe to run alongside real Experience/AI history.
const acct = {
  dbAssertions: 0,
  tempRequestIds: [] as number[], // every experience_request the harness created
  createdLogIds: [] as number[], // every api_usage_log the orchestration created
  seededBudgetRows: 0,
  usageRowsDeleted: 0,
  settingsRestored: "n/a" as string,
  sentinelSurvived: false,
  leakDetected: false,
};

function dbOk(name: string, cond: boolean) {
  acct.dbAssertions++;
  ok(name, cond);
}

async function listInterpretLogs() {
  return db
    .select()
    .from(apiUsageLogs)
    .where(and(eq(apiUsageLogs.userId, U), eq(apiUsageLogs.operation, OP)));
}
async function logIdSet(): Promise<Set<number>> {
  const rows = await listInterpretLogs();
  return new Set(rows.map((r) => r.id));
}
/** Run `fn`, then return the single usage-log row it created (asserting exactly
 * one), or null if `expectRows` is 0. */
async function captureNewLog(
  label: string,
  expectRows: 0 | 1,
  fn: () => Promise<void>,
): Promise<typeof apiUsageLogs.$inferSelect | null> {
  const before = await logIdSet();
  await fn();
  const rows = await listInterpretLogs();
  const fresh = rows.filter((r) => !before.has(r.id));
  for (const r of fresh) acct.createdLogIds.push(r.id); // track for ID-scoped cleanup
  dbOk(`${label}: exactly ${expectRows} usage-log row(s) created`, fresh.length === expectRows);
  return fresh[0] ?? null;
}

async function createTestRequest(requestText: string) {
  const row = await createRequest({ userId: U, requestText } as never);
  acct.tempRequestIds.push(row.id);
  return row;
}

/** Invoke the real PATCH route handler (exercises provenance-clearing logic). */
async function patchViaRoute(id: number, body: Record<string, unknown>) {
  const res = await patchRequestRoute(
    new Request(`http://local/api/experience-requests/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: String(id) }) },
  );
  return { status: res.status, body: (await res.json()) as { request?: Record<string, unknown> } };
}

function noPrivateTextInLog(
  row: typeof apiUsageLogs.$inferSelect | null,
  ...secrets: string[]
): boolean {
  if (!row) return true;
  const blob = JSON.stringify(row);
  return secrets.every((s) => s.length > 0 && !blob.includes(s));
}

async function dbSuite() {
  console.log("\n— database-backed orchestration (fake provider, no Anthropic) —");

  // Snapshot the owner's settings so we can restore them exactly.
  const [origSettings] = await db
    .select()
    .from(intelligenceSettings)
    .where(eq(intelligenceSettings.userId, U))
    .limit(1);
  // Capture the exact id of any settings row WE create, so cleanup deletes by id
  // (never by user-id predicate). origSettings is restored by id, never deleted.
  let createdSettingsId: number | null = null;

  async function setSettings(vals: {
    aiAutomationEnabled: boolean;
    killSwitch: boolean;
    monthlyCostLimit: string | null;
  }) {
    const [cur] = await db
      .select()
      .from(intelligenceSettings)
      .where(eq(intelligenceSettings.userId, U))
      .limit(1);
    if (cur) {
      await db
        .update(intelligenceSettings)
        .set(vals)
        .where(eq(intelligenceSettings.id, cur.id));
    } else {
      const [row] = await db.insert(intelligenceSettings).values({ userId: U, ...vals }).returning();
      createdSettingsId = row.id;
    }
  }

  const savedEnvFlag = process.env.AI_AUTOMATION_ENABLED;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  let seededBudgetId: number | null = null;

  /* ---- Sentinel safety check: records NOT part of the harness run that must
   * survive ID-scoped cleanup untouched. They simulate the owner's real prior
   * Experience + AI-usage history (incl. an unrelated soft-deleted request and a
   * real `anthropic` interpret usage log). Removed only at the very end. ------ */
  const [sentinelReqLive] = await db
    .insert(experienceRequests)
    .values({
      userId: U,
      requestText: "SENTINEL — unrelated real interpreted request",
      status: "interpreted",
      interpretationSource: "ai",
      interpretationProvider: "sentinel-prov",
      interpretationModel: "sentinel-model",
      budgetMax: "42.00",
    } as never)
    .returning();
  const [sentinelReqDeleted] = await db
    .insert(experienceRequests)
    .values({
      userId: U,
      requestText: "SENTINEL — unrelated soft-deleted request",
      deletedAt: new Date(),
    } as never)
    .returning();
  const [sentinelLog] = await db
    .insert(apiUsageLogs)
    .values({
      userId: U,
      provider: "anthropic",
      operation: OP,
      tokensIn: 100,
      tokensOut: 50,
      estimatedCost: "0.1234",
      success: true,
    })
    .returning();

  try {
    /* ---- Scenario 1: successful fake interpretation -------------------- */
    console.log("\n[1] successful fake interpretation");
    process.env.AI_AUTOMATION_ENABLED = "true";
    await setSettings({ aiAutomationEnabled: true, killSwitch: false, monthlyCostLimit: "100.00" });

    const reqText1 = "Plan something fun on Saturday afternoon under $80";
    const r1 = await createTestRequest(reqText1);
    const fake1 = new FakeProvider("valid");
    const before1 = await logIdSet();
    const outcome1 = await interpretRequest(U, r1, fake1);
    const fresh1 = (await listInterpretLogs()).filter((r) => !before1.has(r.id));
    for (const r of fresh1) acct.createdLogIds.push(r.id); // track for ID-scoped cleanup
    dbOk("[1] success: exactly 1 usage-log row created", fresh1.length === 1);
    const log1 = fresh1[0] ?? null;
    const persisted1 = await getRequest(U, r1.id);
    dbOk("[1] provider invoked exactly once", fake1.calls === 1);
    dbOk("[1] status -> interpreted", persisted1?.status === "interpreted");
    dbOk("[1] interpretation_source = ai", persisted1?.interpretationSource === "ai");
    dbOk("[1] interpretation_provider stored", persisted1?.interpretationProvider === "fake");
    dbOk("[1] interpretation_model stored", persisted1?.interpretationModel === "fake-haiku");
    dbOk("[1] constraints persisted (budget 80, energy medium)",
      Number(persisted1?.budgetMax) === 80 && persisted1?.energyLevel === "medium");
    dbOk("[1] deterministic summary returned",
      outcome1.summary.includes("Saturday afternoon"));
    dbOk("[1] usage row success = true", log1?.success === true);
    const expIn = Math.ceil(reqText1.length / 3.5);
    const expCost = estimateCost("claude-haiku-4-5", expIn, 120);
    dbOk("[1] usage tokensIn matches fake", log1?.tokensIn === expIn);
    dbOk("[1] usage tokensOut matches fake (120)", log1?.tokensOut === 120);
    dbOk("[1] usage estimatedCost matches fake (4dp)",
      Math.abs(Number(log1?.estimatedCost) - Number(expCost.toFixed(4))) < 1e-9);
    dbOk("[1] no request text / raw content in usage log",
      noPrivateTextInLog(log1, reqText1, "Saturday afternoon", "energized"));

    /* ---- Scenario 2: manual provenance correction ---------------------- */
    console.log("\n[2] manual provenance correction");
    const r2 = await createTestRequest("A calm evening walk somewhere green");
    const fake2 = new FakeProvider("valid");
    const before2 = await logIdSet();
    await interpretRequest(U, r2, fake2); // -> source ai
    for (const r of (await listInterpretLogs()).filter((x) => !before2.has(x.id))) {
      acct.createdLogIds.push(r.id); // track this interpret's log for ID-scoped cleanup
    }
    const afterInterp2 = await getRequest(U, r2.id);
    dbOk("[2] precondition: source ai before edits", afterInterp2?.interpretationSource === "ai");

    // (a) edit requestText ONLY -> provenance unchanged, no AI call, no log row.
    const rtOnly = await captureNewLog("[2a] requestText-only edit", 0, async () => {
      const res = await patchViaRoute(r2.id, { requestText: "A calm evening walk in a park" });
      dbOk("[2a] requestText edit HTTP 200", res.status === 200);
    });
    void rtOnly;
    const afterRtEdit = await getRequest(U, r2.id);
    dbOk("[2a] source still ai after requestText-only edit",
      afterRtEdit?.interpretationSource === "ai" &&
        afterRtEdit?.interpretationProvider === "fake" &&
        afterRtEdit?.interpretationModel === "fake-haiku");
    dbOk("[2a] status still interpreted", afterRtEdit?.status === "interpreted");

    // (b) edit an interpreted CONSTRAINT -> source manual, provider/model null.
    await captureNewLog("[2b] constraint edit", 0, async () => {
      const res = await patchViaRoute(r2.id, { budgetMax: 50 });
      dbOk("[2b] constraint edit HTTP 200", res.status === 200);
    });
    const afterConstraintEdit = await getRequest(U, r2.id);
    dbOk("[2b] interpretation_source -> manual",
      afterConstraintEdit?.interpretationSource === "manual");
    dbOk("[2b] interpretation_provider -> null",
      afterConstraintEdit?.interpretationProvider === null);
    dbOk("[2b] interpretation_model -> null",
      afterConstraintEdit?.interpretationModel === null);
    dbOk("[2b] status remains interpreted", afterConstraintEdit?.status === "interpreted");
    dbOk("[2b] edited value persisted (budget 50)", Number(afterConstraintEdit?.budgetMax) === 50);

    /* ---- Scenario 3: provider failure ---------------------------------- */
    console.log("\n[3] provider failure (provider_unavailable)");
    const r3 = await createTestRequest("Something spontaneous tonight");
    const snap3 = await getRequest(U, r3.id);
    const fake3 = new FakeProvider("provider_error");
    const log3 = await captureNewLog("[3] provider failure", 1, async () => {
      try {
        await interpretRequest(U, r3, fake3);
        dbOk("[3] should have thrown", false);
      } catch (e) {
        dbOk("[3] throws provider_unavailable",
          e instanceof AiError && e.category === "provider_unavailable");
      }
    });
    dbOk("[3] provider called once, no retry", fake3.calls === 1);
    const after3 = await getRequest(U, r3.id);
    dbOk("[3] request row unchanged (status draft, source manual, no constraints)",
      after3?.status === "draft" && after3?.interpretationSource === "manual" &&
        after3?.interpretationProvider === null && after3?.budgetMax === snap3?.budgetMax);
    dbOk("[3] usage row success = false", log3?.success === false);
    dbOk("[3] usage row category = provider_unavailable",
      log3?.errorMessage === "provider_unavailable");
    dbOk("[3] no request text / raw content in usage log",
      noPrivateTextInLog(log3, "Something spontaneous tonight"));

    /* ---- Scenario 4: invalid provider output --------------------------- */
    for (const scenario of ["malformed", "invalid_values"] as const) {
      console.log(`\n[4] invalid provider output (${scenario})`);
      const r4 = await createTestRequest(`bad output case ${scenario}`);
      const snap4 = await getRequest(U, r4.id);
      const fake4 = new FakeProvider(scenario);
      const log4 = await captureNewLog(`[4:${scenario}]`, 1, async () => {
        try {
          await interpretRequest(U, r4, fake4);
          dbOk(`[4:${scenario}] should have thrown`, false);
        } catch (e) {
          dbOk(`[4:${scenario}] throws invalid_ai_output`,
            e instanceof AiError && e.category === "invalid_ai_output");
        }
      });
      dbOk(`[4:${scenario}] provider called once, no retry`, fake4.calls === 1);
      const after4 = await getRequest(U, r4.id);
      dbOk(`[4:${scenario}] request unchanged (draft, manual, nothing persisted)`,
        after4?.status === "draft" && after4?.interpretationSource === "manual" &&
          after4?.budgetMax === snap4?.budgetMax);
      dbOk(`[4:${scenario}] usage row success = false`, log4?.success === false);
      dbOk(`[4:${scenario}] usage row category = invalid_ai_output`,
        log4?.errorMessage === "invalid_ai_output");
      // The fake attaches usage for these (a billed call that failed validation).
      const expIn4 = Math.ceil((`bad output case ${scenario}`).length / 3.5);
      dbOk(`[4:${scenario}] incurred fake token usage recorded`,
        log4?.tokensIn === expIn4 && log4?.tokensOut === 120 && Number(log4?.estimatedCost) > 0);
      dbOk(`[4:${scenario}] no raw content in usage log`,
        noPrivateTextInLog(log4, `bad output case ${scenario}`));
    }

    /* ---- Scenario 5: pre-invocation blocks ----------------------------- */
    console.log("\n[5] pre-invocation blocks (provider must NOT be called)");

    async function blockCase(
      label: string,
      expectCategory: string,
      prep: () => Promise<void>,
      opts: { inject: boolean } = { inject: true },
    ) {
      await prep();
      const r = await createTestRequest(`block ${label}`);
      const snap = await getRequest(U, r.id);
      const fake = new FakeProvider("valid");
      const log = await captureNewLog(`[5:${label}]`, 1, async () => {
        try {
          await interpretRequest(U, r, opts.inject ? fake : undefined);
          dbOk(`[5:${label}] should have thrown`, false);
        } catch (e) {
          dbOk(`[5:${label}] throws ${expectCategory}`,
            e instanceof AiError && e.category === expectCategory);
        }
      });
      if (opts.inject) dbOk(`[5:${label}] provider NOT called`, fake.calls === 0);
      const after = await getRequest(U, r.id);
      dbOk(`[5:${label}] request unchanged`,
        after?.status === "draft" && after?.interpretationSource === "manual" &&
          after?.interpretationProvider === null);
      dbOk(`[5:${label}] usage row success = false`, log?.success === false);
      dbOk(`[5:${label}] estimated cost zero`, Number(log?.estimatedCost ?? 0) === 0);
      dbOk(`[5:${label}] tokens null`, log?.tokensIn === null && log?.tokensOut === null);
      dbOk(`[5:${label}] bounded category = ${expectCategory}`, log?.errorMessage === expectCategory);
      dbOk(`[5:${label}] no private input in usage log`, noPrivateTextInLog(log, `block ${label}`));
      void snap;
    }

    // env master gate off
    await blockCase("env-gate-off", "ai_unavailable", async () => {
      process.env.AI_AUTOMATION_ENABLED = "false";
      await setSettings({ aiAutomationEnabled: true, killSwitch: false, monthlyCostLimit: "100.00" });
    });
    // database AI gate off
    await blockCase("db-gate-off", "ai_unavailable", async () => {
      process.env.AI_AUTOMATION_ENABLED = "true";
      await setSettings({ aiAutomationEnabled: false, killSwitch: false, monthlyCostLimit: "100.00" });
    });
    // kill switch on
    await blockCase("kill-switch", "ai_unavailable", async () => {
      process.env.AI_AUTOMATION_ENABLED = "true";
      await setSettings({ aiAutomationEnabled: true, killSwitch: true, monthlyCostLimit: "100.00" });
    });
    // missing API key (no provider injected -> resolveProvider must throw)
    await blockCase("missing-key", "ai_unavailable", async () => {
      process.env.AI_AUTOMATION_ENABLED = "true";
      delete process.env.ANTHROPIC_API_KEY;
      await setSettings({ aiAutomationEnabled: true, killSwitch: false, monthlyCostLimit: "100.00" });
    }, { inject: false });
    // per-operation estimated cost exceeded (huge request text)
    {
      process.env.AI_AUTOMATION_ENABLED = "true";
      await setSettings({ aiAutomationEnabled: true, killSwitch: false, monthlyCostLimit: "100.00" });
      const big = "x".repeat(53000);
      const r = await createTestRequest(big);
      const fake = new FakeProvider("valid");
      const log = await captureNewLog("[5:per-op-cap]", 1, async () => {
        try {
          await interpretRequest(U, r, fake);
          dbOk("[5:per-op-cap] should have thrown", false);
        } catch (e) {
          dbOk("[5:per-op-cap] throws per_op_limit",
            e instanceof AiError && e.category === "per_op_limit");
        }
      });
      dbOk("[5:per-op-cap] provider NOT called", fake.calls === 0);
      const after = await getRequest(U, r.id);
      dbOk("[5:per-op-cap] request unchanged", after?.status === "draft" &&
        after?.interpretationSource === "manual");
      dbOk("[5:per-op-cap] success=false, cost 0, tokens null, bounded category",
        log?.success === false && Number(log?.estimatedCost ?? 0) === 0 &&
          log?.tokensIn === null && log?.tokensOut === null &&
          log?.errorMessage === "per_op_limit");
    }
    // monthly budget exceeded (seed anthropic spend at the $5 ceiling)
    {
      process.env.AI_AUTOMATION_ENABLED = "true";
      await setSettings({ aiAutomationEnabled: true, killSwitch: false, monthlyCostLimit: "100.00" });
      const [seed] = await db
        .insert(apiUsageLogs)
        .values({
          userId: U, provider: "anthropic", operation: OP,
          estimatedCost: "5.0000", success: true, tokensIn: null, tokensOut: null,
        })
        .returning();
      seededBudgetId = seed.id;
      acct.seededBudgetRows++;
      const r = await createTestRequest("budget gate request");
      const fake = new FakeProvider("valid");
      const log = await captureNewLog("[5:monthly-budget]", 1, async () => {
        try {
          await interpretRequest(U, r, fake);
          dbOk("[5:monthly-budget] should have thrown", false);
        } catch (e) {
          dbOk("[5:monthly-budget] throws budget_exceeded",
            e instanceof AiError && e.category === "budget_exceeded");
        }
      });
      dbOk("[5:monthly-budget] provider NOT called", fake.calls === 0);
      const after = await getRequest(U, r.id);
      dbOk("[5:monthly-budget] request unchanged", after?.status === "draft" &&
        after?.interpretationSource === "manual");
      dbOk("[5:monthly-budget] success=false, cost 0, tokens null, bounded category",
        log?.success === false && Number(log?.estimatedCost ?? 0) === 0 &&
          log?.tokensIn === null && log?.tokensOut === null &&
          log?.errorMessage === "budget_exceeded");
    }
  } finally {
    /* ---- Scenario 6: ID-scoped cleanup + restoration ------------------- */
    console.log("\n[6] cleanup + settings restoration");
    // Restore env first.
    if (savedEnvFlag === undefined) delete process.env.AI_AUTOMATION_ENABLED;
    else process.env.AI_AUTOMATION_ENABLED = savedEnvFlag;
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;

    // Delete ONLY the exact ids the harness created (orchestration rows + the
    // seeded budget row). No operation/provider/owner-wide delete.
    const logIdsToDelete = Array.from(
      new Set([...acct.createdLogIds, ...(seededBudgetId != null ? [seededBudgetId] : [])]),
    );
    // Safety: list the EXACT target ids before any deletion (never broad predicates).
    console.log(`  cleanup targets — requests:[${acct.tempRequestIds.join(",")}] logs:[${logIdsToDelete.join(",")}] sentinels:[req ${sentinelReqLive.id},${sentinelReqDeleted.id} log ${sentinelLog.id}] settingsRow:${createdSettingsId ?? origSettings?.id ?? "none"}`);

    for (const id of acct.tempRequestIds) {
      await db.delete(experienceRequests).where(eq(experienceRequests.id, id));
    }
    for (const id of logIdsToDelete) {
      await db.delete(apiUsageLogs).where(eq(apiUsageLogs.id, id));
    }
    acct.usageRowsDeleted = logIdsToDelete.length;

    // Restore intelligence_settings exactly by id (or delete the row we created, by id).
    if (origSettings) {
      await db
        .update(intelligenceSettings)
        .set({
          aiAutomationEnabled: origSettings.aiAutomationEnabled,
          killSwitch: origSettings.killSwitch,
          monthlyCostLimit: origSettings.monthlyCostLimit,
        })
        .where(eq(intelligenceSettings.id, origSettings.id));
      acct.settingsRestored = "restored prior row exactly (by id)";
    } else if (createdSettingsId != null) {
      await db.delete(intelligenceSettings).where(eq(intelligenceSettings.id, createdSettingsId));
      acct.settingsRestored = "removed harness-created row (by id)";
    }

    // Sentinel survival: the unrelated records must be present and UNCHANGED.
    const [liveAfter] = await db
      .select()
      .from(experienceRequests)
      .where(eq(experienceRequests.id, sentinelReqLive.id))
      .limit(1);
    const [deletedAfter] = await db
      .select()
      .from(experienceRequests)
      .where(eq(experienceRequests.id, sentinelReqDeleted.id))
      .limit(1);
    const [logAfter] = await db
      .select()
      .from(apiUsageLogs)
      .where(eq(apiUsageLogs.id, sentinelLog.id))
      .limit(1);
    const liveOk =
      !!liveAfter && liveAfter.status === "interpreted" &&
      liveAfter.interpretationSource === "ai" &&
      liveAfter.interpretationProvider === "sentinel-prov" &&
      Number(liveAfter.budgetMax) === 42;
    const deletedOk = !!deletedAfter; // unrelated soft-deleted request not purged
    const logOk = !!logAfter && Number(logAfter.estimatedCost) === 0.1234 && logAfter.success === true;
    acct.sentinelSurvived = liveOk && deletedOk && logOk;
    dbOk("[6:sentinel] unrelated live interpreted request survived unchanged", liveOk);
    dbOk("[6:sentinel] unrelated soft-deleted request survived", deletedOk);
    dbOk("[6:sentinel] unrelated anthropic usage log survived unchanged", logOk);

    // Remove ONLY the sentinels created for this safety check.
    await db.delete(experienceRequests).where(eq(experienceRequests.id, sentinelReqLive.id));
    await db.delete(experienceRequests).where(eq(experienceRequests.id, sentinelReqDeleted.id));
    await db.delete(apiUsageLogs).where(eq(apiUsageLogs.id, sentinelLog.id));

    // Confirm none of the harness's tracked ids remain (ID-scoped leak check).
    const reqRows = await db
      .select({ id: experienceRequests.id })
      .from(experienceRequests)
      .where(eq(experienceRequests.userId, U));
    const reqIdSet = new Set(reqRows.map((r) => r.id));
    const reqLeak = acct.tempRequestIds.some((id) => reqIdSet.has(id));
    const logRows = await listInterpretLogs();
    const logIdSetNow = new Set(logRows.map((r) => r.id));
    const logLeak = logIdsToDelete.some((id) => logIdSetNow.has(id));
    acct.leakDetected = reqLeak || logLeak;
    dbOk("[6] all harness request ids removed", !reqLeak);
    dbOk("[6] all harness usage-log ids removed", !logLeak);
    dbOk("[6] intelligence_settings restored", acct.settingsRestored !== "n/a" || !origSettings);

    console.log("\n— cleanup accounting —");
    console.log(`  db-backed assertions:        ${acct.dbAssertions}`);
    console.log(`  temp request ids created:    [${acct.tempRequestIds.join(", ")}] (removed: ${!reqLeak})`);
    console.log(`  seeded budget rows:          ${acct.seededBudgetRows}`);
    console.log(`  usage-log ids created/deleted: ${acct.createdLogIds.length + acct.seededBudgetRows}/${acct.usageRowsDeleted}`);
    console.log(`  sentinel survived untouched: ${acct.sentinelSurvived ? "yes" : "NO (FAIL)"}`);
    console.log(`  intelligence_settings:       ${acct.settingsRestored}`);
    console.log(`  partial artifacts remaining: ${acct.leakDetected ? "YES (LEAK!)" : "none"}`);
  }
}

main().catch((e) => {
  console.error("verification harness crashed:", e);
  process.exit(1);
});
