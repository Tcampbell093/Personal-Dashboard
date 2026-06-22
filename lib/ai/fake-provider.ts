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
  type InterpretationInput,
  type InterpretationResult,
} from "./provider";
import { estimateCost } from "./cost";

export type FakeScenario = "valid" | "malformed" | "invalid_values" | "provider_error";

export class FakeProvider implements ExperienceAiProvider {
  /** Number of times the provider was actually invoked — lets tests assert that
   * blocked-before-invocation paths never reached the provider. */
  public calls = 0;

  constructor(
    private scenario: FakeScenario = "valid",
    private model = "fake-haiku",
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
}
