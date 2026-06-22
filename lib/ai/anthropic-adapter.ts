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
  type InterpretationInput,
  type InterpretationResult,
} from "./provider";
import { INTERPRET_MODEL } from "./models";
import { INTERPRETATION_JSON_SCHEMA, validateInterpretation } from "./interpretation-schema";
import { estimateCost } from "./cost";

const INTERPRET_MAX_TOKENS = 1024;

const INTERPRET_SYSTEM = `You convert a person's natural-language description of a desired outing into structured planning constraints.
Return ONLY the structured fields defined by the schema. Use null for any field the request does not imply — never guess.
Resolve any relative date to an absolute YYYY-MM-DD using the provided current date.
You are extracting constraints, NOT making recommendations: do not invent venues, events, prices, weather, or travel times.`;

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
}
