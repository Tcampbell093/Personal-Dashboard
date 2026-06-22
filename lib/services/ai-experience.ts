/* Owner-triggered AI orchestration for the Experience loop (Build 2A).
 *
 * The ONLY caller of the provider. Enforces enablement + cost gates BEFORE any
 * provider call, records bounded usage metadata (never prompts/request text/raw
 * responses), and leaves the manual path usable on every failure.
 *
 * The provider is server-owned (resolveProvider). A provider may be injected as
 * an argument ONLY by the verification harness — never from request input. */

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { intelligenceSettings, apiUsageLogs } from "@/db/schema";
import {
  AiError,
  type AiUsage,
  type ExperienceAiProvider,
  type RecommendationConstraints,
} from "@/lib/ai/provider";
import { resolveProvider } from "@/lib/ai/provider-factory";
import { INTERPRET_MODEL, RECOMMEND_MODEL, RECOMMEND_MAX_TOKENS } from "@/lib/ai/models";
import {
  enforceBudget,
  estimateInputTokens,
  monthToDateSpend,
} from "@/lib/ai/cost";
import {
  applyInterpretation,
  applyRecommendations,
  getHomeArea,
  getRequest,
  interpretationSummary,
  toRequestView,
  type ExperienceRequestRow,
} from "@/lib/services/experience-requests";
import type { ExperienceRequestView } from "@/lib/types";

const INTERPRET_OP = "experience_interpret";
const INTERPRET_MAX_TOKENS = 1024;
const RECOMMEND_OP = "experience_recommend";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Bounded metadata only — never request text, prompts, or raw responses. */
async function logUsage(opts: {
  userId: number;
  operation: string;
  success: boolean;
  usage?: AiUsage;
  category?: string;
}): Promise<void> {
  await db.insert(apiUsageLogs).values({
    userId: opts.userId,
    provider: opts.usage?.provider ?? "anthropic",
    operation: opts.operation,
    tokensIn: opts.usage?.tokensIn ?? null,
    tokensOut: opts.usage?.tokensOut ?? null,
    estimatedCost: String(opts.usage?.estimatedCost ?? 0),
    success: opts.success,
    errorMessage: opts.category ?? null,
  });
}

export interface InterpretOutcome {
  request: ExperienceRequestView;
  summary: string;
}

/** Run owner-triggered interpretation on an owned, non-deleted request that has
 * request text. `provider` is injected only by the verification harness. */
export async function interpretRequest(
  userId: number,
  request: ExperienceRequestRow,
  provider?: ExperienceAiProvider,
): Promise<InterpretOutcome> {
  try {
    // 1. Environment master gate.
    if (process.env.AI_AUTOMATION_ENABLED !== "true") {
      throw new AiError("ai_unavailable", 503, "AI automation is disabled (environment).");
    }
    // 2. Database gate + kill switch.
    const [settings] = await db
      .select()
      .from(intelligenceSettings)
      .where(eq(intelligenceSettings.userId, userId))
      .limit(1);
    if (!settings || !settings.aiAutomationEnabled) {
      throw new AiError("ai_unavailable", 503, "AI is disabled in settings.");
    }
    if (settings.killSwitch) {
      throw new AiError("ai_unavailable", 503, "AI kill switch is on.");
    }
    // 3. Cost gate — before any provider invocation.
    const monthToDate = await monthToDateSpend();
    enforceBudget({
      op: "interpret",
      model: INTERPRET_MODEL,
      estInputTokens: estimateInputTokens(request.requestText),
      maxOutputTokens: INTERPRET_MAX_TOKENS,
      monthToDate,
      monthlyCostLimit:
        settings.monthlyCostLimit != null ? Number(settings.monthlyCostLimit) : null,
    });
    // 4. Resolve the server-owned provider (or use the injected one for tests).
    const prov = provider ?? resolveProvider();

    // 5. Owner-triggered call — minimal context only.
    const homeArea = await getHomeArea(userId);
    const { result, usage } = await prov.interpret({
      requestText: request.requestText,
      homeArea,
      today: todayIso(),
    });

    const updated = await applyInterpretation(userId, request.id, result, usage);
    await logUsage({ userId, operation: INTERPRET_OP, success: true, usage });
    const view = toRequestView(updated!);
    return { request: view, summary: interpretationSummary(view) };
  } catch (err) {
    const aiErr =
      err instanceof AiError
        ? err
        : new AiError("provider_unavailable", 502, "Unexpected AI failure.");
    await logUsage({
      userId,
      operation: INTERPRET_OP,
      success: false,
      usage: aiErr.usage, // present only when a (billed) call actually happened
      category: aiErr.category,
    });
    throw aiErr;
  }
}

/* --- Recommendations (Build 2B.1) ---------------------------------------- */

export interface RecommendOutcome {
  request: ExperienceRequestView;
}

/** Run owner-triggered recommendation generation (or regeneration) on an owned,
 * non-deleted request that has request text. Sends only the request text and
 * stored current constraints (missing constraints stay missing). `provider` is
 * injected only by the verification harness. */
export async function generateRecommendations(
  userId: number,
  request: ExperienceRequestRow,
  provider?: ExperienceAiProvider,
): Promise<RecommendOutcome> {
  try {
    // 1. Environment master gate.
    if (process.env.AI_AUTOMATION_ENABLED !== "true") {
      throw new AiError("ai_unavailable", 503, "AI automation is disabled (environment).");
    }
    // 2. Database gate + kill switch.
    const [settings] = await db
      .select()
      .from(intelligenceSettings)
      .where(eq(intelligenceSettings.userId, userId))
      .limit(1);
    if (!settings || !settings.aiAutomationEnabled) {
      throw new AiError("ai_unavailable", 503, "AI is disabled in settings.");
    }
    if (settings.killSwitch) {
      throw new AiError("ai_unavailable", 503, "AI kill switch is on.");
    }

    // Build constraints from the stored current values only — no invented defaults.
    const view = toRequestView(request);
    const constraints: RecommendationConstraints = {
      availableDate: view.availableDate,
      availableTimeText: view.availableTimeText,
      budgetMax: view.budgetMax,
      startingLocation: view.startingLocation,
      maxTravelMiles: view.maxTravelMiles,
      maxTravelMinutes: view.maxTravelMinutes,
      energyLevel: view.energyLevel,
      desiredFeeling: view.desiredFeeling,
      maxPhysicalDifficulty: view.maxPhysicalDifficulty,
      interests: view.interests,
      exclusions: view.exclusions,
    };

    // 3. Cost gate — before any provider invocation. The $0.05 per-op cap is
    //    enforced here and is never weakened to fit a larger prompt.
    const monthToDate = await monthToDateSpend();
    enforceBudget({
      op: "recommend",
      model: RECOMMEND_MODEL,
      estInputTokens: estimateInputTokens(request.requestText + JSON.stringify(constraints)),
      maxOutputTokens: RECOMMEND_MAX_TOKENS,
      monthToDate,
      monthlyCostLimit:
        settings.monthlyCostLimit != null ? Number(settings.monthlyCostLimit) : null,
    });

    // 4. Resolve the server-owned provider (or use the injected one for tests).
    const prov = provider ?? resolveProvider();

    // 5. Owner-triggered call — minimal context only.
    const homeArea = await getHomeArea(userId);
    const { result, usage } = await prov.recommend({
      requestText: request.requestText,
      constraints,
      homeArea,
      today: todayIso(),
    });

    const updated = await applyRecommendations(userId, request.id, result, usage);
    await logUsage({ userId, operation: RECOMMEND_OP, success: true, usage });
    return { request: toRequestView(updated!) };
  } catch (err) {
    const aiErr =
      err instanceof AiError
        ? err
        : new AiError("provider_unavailable", 502, "Unexpected AI failure.");
    await logUsage({
      userId,
      operation: RECOMMEND_OP,
      success: false,
      usage: aiErr.usage,
      category: aiErr.category,
    });
    throw aiErr;
  }
}
