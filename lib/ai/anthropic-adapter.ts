/* Anthropic implementation of ExperienceAiProvider.
 *
 * This is the ONLY file that imports @anthropic-ai/sdk. Server-side only.
 * Structured output via output_config.format (json_schema); no extended
 * thinking; no retries. Converts provider output into the application contract
 * and returns bounded usage metadata. */

import Anthropic from "@anthropic-ai/sdk";
import {
  AiError,
  type AiUsage,
  type ExperienceAiProvider,
  type ExperienceRecommendation,
  type InterpretationInput,
  type InterpretationResult,
  type RecommendationInput,
} from "./provider";
import { INTERPRET_MODEL, RECOMMEND_MODEL, RECOMMEND_MAX_TOKENS } from "./models";
import { INTERPRETATION_JSON_SCHEMA, validateInterpretation } from "./interpretation-schema";
import {
  RECOMMENDATIONS_JSON_SCHEMA,
  RECOMMENDATION_BATCH_SIZE,
  validateRecommendationBatch,
} from "./recommendation-schema";
import { estimateCost } from "./cost";

const INTERPRET_MAX_TOKENS = 1024;

const INTERPRET_SYSTEM = `You convert a person's natural-language description of a desired outing into structured planning constraints.
Return ONLY the structured fields defined by the schema. Use null for any field the request does not imply — never guess.
Resolve any relative date to an absolute YYYY-MM-DD using the provided current date.
You are extracting constraints, NOT making recommendations: do not invent venues, events, prices, weather, or travel times.`;

const RECOMMEND_SYSTEM = `You propose exactly ${RECOMMENDATION_BATCH_SIZE} DIFFERENTIATED experience CONCEPTS that fit the person's request and confirmed constraints.
Return ONLY the structured fields defined by the schema. Do not include ids.
These are concepts, not verified facts. You MUST NOT state or imply that a business is currently open, an event is scheduled, a ticket is available, a price is live or verified, the weather is suitable, travel time has been checked, a reservation exists, or availability is confirmed.
Express any cost, duration, distance, or travel detail as an explicit ESTIMATE or ASSUMPTION, and put such caveats in the "assumptions" array.
Use null for any field you cannot responsibly estimate — never invent specifics. Make the three concepts meaningfully different from each other.`;

export class AnthropicProvider implements ExperienceAiProvider {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string = INTERPRET_MODEL) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async interpret(
    input: InterpretationInput,
  ): Promise<{ result: InterpretationResult; usage: AiUsage }> {
    const userMsg = [
      `Current date: ${input.today}`,
      input.homeArea
        ? `Home area (default starting location if the request states none): ${input.homeArea}`
        : "No home area on file.",
      `Request: ${input.requestText}`,
    ].join("\n");

    let resp: {
      model?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
      content?: Array<{ type: string; text?: string }>;
    };
    try {
      // output_config.format is cast through `any` so the call compiles across
      // SDK minor versions; the field is sent to the API verbatim.
      resp = (await this.client.messages.create({
        model: this.model,
        max_tokens: INTERPRET_MAX_TOKENS,
        system: INTERPRET_SYSTEM,
        messages: [{ role: "user", content: userMsg }],
        output_config: { format: { type: "json_schema", schema: INTERPRETATION_JSON_SCHEMA } },
      } as never)) as never;
    } catch (err) {
      const msg = String((err as Error)?.message ?? err).slice(0, 200);
      throw new AiError("provider_unavailable", 502, `Anthropic request failed: ${msg}`);
    }

    const model = resp.model ?? this.model;
    const tokensIn = resp.usage?.input_tokens ?? 0;
    const tokensOut = resp.usage?.output_tokens ?? 0;
    const usage: AiUsage = {
      provider: "anthropic",
      model,
      tokensIn,
      tokensOut,
      estimatedCost: estimateCost(model, tokensIn, tokensOut),
    };

    const text =
      (resp.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("") || "";

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      const e = new AiError("invalid_ai_output", 422, "Provider did not return valid JSON.");
      e.usage = usage;
      throw e;
    }

    try {
      const result = validateInterpretation(parsed);
      return { result, usage };
    } catch (err) {
      // Attach usage so the orchestrator can log the (billed) failed call.
      if (err instanceof AiError) {
        err.usage = usage;
        throw err;
      }
      const e = new AiError("invalid_ai_output", 422, "Interpretation failed validation.");
      e.usage = usage;
      throw e;
    }
  }

  async recommend(
    input: RecommendationInput,
  ): Promise<{ result: ExperienceRecommendation[]; usage: AiUsage }> {
    const c = input.constraints;
    // Only include constraints the owner actually has — missing stays missing.
    const lines: string[] = [`Current date: ${input.today}`];
    if (input.homeArea) lines.push(`General home area: ${input.homeArea}`);
    lines.push(`Request: ${input.requestText}`);
    const constraintBits: string[] = [];
    if (c.availableDate) constraintBits.push(`date ${c.availableDate}`);
    if (c.availableTimeText) constraintBits.push(`time ${c.availableTimeText}`);
    if (c.budgetMax != null) constraintBits.push(`budget up to $${c.budgetMax}`);
    if (c.startingLocation) constraintBits.push(`starting from ${c.startingLocation}`);
    if (c.maxTravelMiles != null) constraintBits.push(`<= ${c.maxTravelMiles} miles`);
    if (c.maxTravelMinutes != null) constraintBits.push(`<= ${c.maxTravelMinutes} minutes travel`);
    if (c.energyLevel) constraintBits.push(`${c.energyLevel} energy`);
    if (c.maxPhysicalDifficulty) constraintBits.push(`<= ${c.maxPhysicalDifficulty} difficulty`);
    if (c.desiredFeeling) constraintBits.push(`wants to feel ${c.desiredFeeling}`);
    if (c.interests.length) constraintBits.push(`interests: ${c.interests.join(", ")}`);
    if (c.exclusions.length) constraintBits.push(`avoid: ${c.exclusions.join(", ")}`);
    lines.push(
      constraintBits.length
        ? `Confirmed constraints: ${constraintBits.join("; ")}.`
        : "No additional constraints were provided.",
    );

    const model = RECOMMEND_MODEL;
    let resp: {
      model?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
      content?: Array<{ type: string; text?: string }>;
    };
    try {
      resp = (await this.client.messages.create({
        model,
        max_tokens: RECOMMEND_MAX_TOKENS,
        system: RECOMMEND_SYSTEM,
        messages: [{ role: "user", content: lines.join("\n") }],
        output_config: { format: { type: "json_schema", schema: RECOMMENDATIONS_JSON_SCHEMA } },
      } as never)) as never;
    } catch (err) {
      const msg = String((err as Error)?.message ?? err).slice(0, 200);
      throw new AiError("provider_unavailable", 502, `Anthropic request failed: ${msg}`);
    }

    const respModel = resp.model ?? model;
    const tokensIn = resp.usage?.input_tokens ?? 0;
    const tokensOut = resp.usage?.output_tokens ?? 0;
    const usage: AiUsage = {
      provider: "anthropic",
      model: respModel,
      tokensIn,
      tokensOut,
      estimatedCost: estimateCost(respModel, tokensIn, tokensOut),
    };

    const text =
      (resp.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("") || "";

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      const e = new AiError("invalid_ai_output", 422, "Provider did not return valid JSON.");
      e.usage = usage;
      throw e;
    }

    try {
      const result = validateRecommendationBatch(parsed);
      return { result, usage };
    } catch (err) {
      if (err instanceof AiError) {
        err.usage = usage;
        throw err;
      }
      const e = new AiError("invalid_ai_output", 422, "Recommendations failed validation.");
      e.usage = usage;
      throw e;
    }
  }
}
