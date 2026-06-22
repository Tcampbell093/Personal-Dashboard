/* Single source of truth for AI model identifiers + pricing.
 *
 * Model IDs are environment-configurable with documented, non-secret defaults
 * (verified 2026-06-22 against platform.claude.com). Do NOT hard-code model ids
 * anywhere else — import from here. */

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

// Verified Anthropic model identifiers + pricing (USD per 1M tokens).
const PRICING: Record<string, ModelPricing> = {
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
};

export const INTERPRET_MODEL =
  process.env.EXPERIENCE_INTERPRET_MODEL?.trim() || "claude-haiku-4-5";

// Used by Build 2B (recommendations). Documented here for a single source; unused in 2A.
export const RECOMMEND_MODEL =
  process.env.EXPERIENCE_RECOMMEND_MODEL?.trim() || "claude-sonnet-4-6";

/** Pricing for a model; for an unknown configured id, fall back to the priciest
 * known tier so cost estimates never under-count. */
export function pricingFor(model: string): ModelPricing {
  return PRICING[model] ?? { inputPerMTok: 3, outputPerMTok: 15 };
}
