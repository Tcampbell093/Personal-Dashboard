/* Application-owned AI provider boundary.
 *
 * Domain services and routes depend on THIS interface and these contracts —
 * never on @anthropic-ai/sdk directly. Build 2A defines only `interpret`;
 * Build 2B will add recommendation generation. */

import type {
  EnergyLevel,
  ExperienceRecommendation,
  PhysicalDifficulty,
} from "@/lib/types";

export type { ExperienceRecommendation };

export type AiErrorCategory =
  | "ai_unavailable"
  | "budget_exceeded"
  | "per_op_limit"
  | "provider_unavailable"
  | "invalid_ai_output";

/** Typed failure carrying the HTTP status a route should return. Never holds
 * raw prompts, request text, or model responses. */
export class AiError extends Error {
  /** Optional usage attached when a call DID reach the provider (e.g. a
   * validation failure after a billed response) so the orchestrator can log it. */
  usage?: AiUsage;
  constructor(
    public category: AiErrorCategory,
    public httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = "AiError";
  }
}

export interface AiUsage {
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  estimatedCost: number;
}

export interface InterpretationInput {
  requestText: string;
  homeArea: string | null;
  today: string; // YYYY-MM-DD
}

/** Application-owned, validated interpretation result. Maps 1:1 to the editable
 * constraint columns of experience_requests. */
export interface InterpretationResult {
  availableDate: string | null;
  availableTimeText: string | null;
  budgetMax: number | null;
  startingLocation: string | null;
  maxTravelMiles: number | null;
  maxTravelMinutes: number | null;
  energyLevel: EnergyLevel | null;
  desiredFeeling: string | null;
  maxPhysicalDifficulty: PhysicalDifficulty | null;
  interests: string[];
  exclusions: string[];
}

/** Owner-confirmed constraints sent for recommendation generation. Mirrors the
 * stored constraint columns; missing values stay null (no invented defaults). */
export interface RecommendationConstraints {
  availableDate: string | null;
  availableTimeText: string | null;
  budgetMax: number | null;
  startingLocation: string | null;
  maxTravelMiles: number | null;
  maxTravelMinutes: number | null;
  energyLevel: EnergyLevel | null;
  desiredFeeling: string | null;
  maxPhysicalDifficulty: PhysicalDifficulty | null;
  interests: string[];
  exclusions: string[];
}

export interface RecommendationInput {
  requestText: string;
  constraints: RecommendationConstraints;
  homeArea: string | null;
  today: string; // YYYY-MM-DD
}

export interface ExperienceAiProvider {
  interpret(
    input: InterpretationInput,
  ): Promise<{ result: InterpretationResult; usage: AiUsage }>;
  /** Build 2B.1: generate exactly three validated experience concepts. The
   * returned recommendations already carry application-assigned ids. */
  recommend(
    input: RecommendationInput,
  ): Promise<{ result: ExperienceRecommendation[]; usage: AiUsage }>;
}
