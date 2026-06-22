/* Deterministic fake provider — FOR VERIFICATION ONLY.
 *
 * SECURITY: this is reachable solely through server-side dependency injection
 * (a function argument) and scripts/verify-build2a.ts. It is NEVER selected by
 * the production provider factory and is NEVER reachable via any client-supplied
 * input (request body, query string, header, or cookie). The production route
 * always uses resolveProvider() in provider-factory.ts. */

import {
  AiError,
  type AiUsage,
  type ExperienceAiProvider,
  type ExperienceRecommendation,
  type InterpretationInput,
  type InterpretationResult,
  type RecommendationInput,
} from "./provider";
import { estimateCost } from "./cost";
import { validateRecommendationBatch } from "./recommendation-schema";

export type FakeScenario = "valid" | "malformed" | "invalid_values" | "provider_error";
export type FakeRecScenario =
  | "valid3"
  | "malformed"
  | "wrong_length"
  | "bad_costs"
  | "invalid_difficulty"
  | "bad_array"
  | "oversized"
  | "provider_error";

export class FakeProvider implements ExperienceAiProvider {
  /** Number of times the provider was actually invoked — lets tests assert that
   * blocked-before-invocation paths never reached the provider. */
  public calls = 0;

  constructor(
    private scenario: FakeScenario = "valid",
    private model = "fake-haiku",
    private recScenario: FakeRecScenario = "valid3",
    private recModel = "fake-sonnet",
  ) {}

  async interpret(
    input: InterpretationInput,
  ): Promise<{ result: InterpretationResult; usage: AiUsage }> {
    this.calls++;
    const tokensIn = Math.ceil(input.requestText.length / 3.5);
    const tokensOut = 120;
    const usage: AiUsage = {
      provider: "fake",
      model: this.model,
      tokensIn,
      tokensOut,
      estimatedCost: estimateCost("claude-haiku-4-5", tokensIn, tokensOut),
    };

    if (this.scenario === "provider_error") {
      throw new AiError("provider_unavailable", 502, "fake: provider unavailable");
    }
    if (this.scenario === "malformed" || this.scenario === "invalid_values") {
      // A call that reached the provider but failed validation — usage attached.
      const e = new AiError("invalid_ai_output", 422, `fake: ${this.scenario}`);
      e.usage = usage;
      throw e;
    }

    const result: InterpretationResult = {
      availableDate: null,
      availableTimeText: "Saturday afternoon",
      budgetMax: 80,
      startingLocation: input.homeArea,
      maxTravelMiles: null,
      maxTravelMinutes: 45,
      energyLevel: "medium",
      desiredFeeling: "energized",
      maxPhysicalDifficulty: "easy",
      interests: ["local"],
      exclusions: [],
    };
    return { result, usage };
  }

  async recommend(
    input: RecommendationInput,
  ): Promise<{ result: ExperienceRecommendation[]; usage: AiUsage }> {
    this.calls++;
    const tokensIn = Math.ceil(
      (input.requestText.length + JSON.stringify(input.constraints).length) / 3.5,
    );
    const tokensOut = 300;
    const usage: AiUsage = {
      provider: "fake",
      model: this.recModel,
      tokensIn,
      tokensOut,
      estimatedCost: estimateCost("claude-sonnet-4-6", tokensIn, tokensOut),
    };

    if (this.recScenario === "provider_error") {
      throw new AiError("provider_unavailable", 502, "fake: provider unavailable");
    }

    const raw = buildFakeRecommendations(this.recScenario);
    try {
      // Runs the SAME application validation the real adapter uses, so the fake
      // returns id-assigned recommendations and throws the same typed errors.
      const result = validateRecommendationBatch(raw);
      return { result, usage };
    } catch (err) {
      if (err instanceof AiError) {
        err.usage = usage; // a billed call that failed validation
        throw err;
      }
      throw err;
    }
  }
}

/** Build raw (pre-validation) provider output for each deterministic scenario. */
function buildFakeRecommendations(scenario: FakeRecScenario): unknown {
  if (scenario === "malformed") return 42; // not an array/object
  const good = (i: number) => ({
    title: `Concept ${i}`,
    description: `A differentiated experience concept number ${i}.`,
    whyItFits: `It matches the stated constraints in way ${i}.`,
    estimatedCostMin: 20 * i,
    estimatedCostMax: 30 * i,
    estimatedDurationMinutes: 60 * i,
    locationText: `Area ${i}`,
    travelAssumption: "Estimated, not verified.",
    physicalDifficulty: ["easy", "moderate", "challenging"][i - 1] ?? "easy",
    intendedFeeling: "energized",
    assumptions: ["Hours, pricing, and availability are assumed — confirm before going."],
    preparationNotes: ["Check current details."],
  });
  const three = [good(1), good(2), good(3)];
  switch (scenario) {
    case "wrong_length":
      return { recommendations: [good(1), good(2)] };
    case "bad_costs":
      return { recommendations: [{ ...good(1), estimatedCostMin: 50, estimatedCostMax: 10 }, good(2), good(3)] };
    case "invalid_difficulty":
      return { recommendations: [{ ...good(1), physicalDifficulty: "extreme" }, good(2), good(3)] };
    case "bad_array":
      return { recommendations: [{ ...good(1), assumptions: "not-an-array" }, good(2), good(3)] };
    case "oversized":
      return { recommendations: [{ ...good(1), title: "x".repeat(400) }, good(2), good(3)] };
    case "valid3":
    default:
      return { recommendations: three };
  }
}
