/* Recommendations (Build 2B.1): provider structured-output JSON schema +
 * application-level whole-batch validation.
 *
 * The provider is asked for exactly three concepts WITHOUT ids. After the whole
 * batch passes validation the application assigns each a globally-unique opaque
 * id (`rec_<uuid>`) — the model never provides or controls ids. Any violation
 * rejects the ENTIRE batch (no partial persistence). Raw output is never stored. */

import { randomUUID } from "node:crypto";
import { AiError, type ExperienceRecommendation } from "./provider";

export const RECOMMENDATION_BATCH_SIZE = 3;

const DIFFICULTY = ["easy", "moderate", "challenging"];

// Application-level caps to bound provider output (defence-in-depth alongside max_tokens).
const CAP = {
  title: 140,
  description: 600,
  whyItFits: 400,
  locationText: 200,
  travelAssumption: 200,
  intendedFeeling: 120,
  arrayItems: 8,
  arrayItemChars: 160,
} as const;

/** Schema for ONE recommendation as requested from the provider (no id). */
const RECOMMENDATION_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    description: { type: "string" },
    whyItFits: { type: "string" },
    estimatedCostMin: { type: ["number", "null"] },
    estimatedCostMax: { type: ["number", "null"] },
    estimatedDurationMinutes: { type: ["integer", "null"] },
    locationText: { type: ["string", "null"] },
    travelAssumption: { type: ["string", "null"] },
    physicalDifficulty: {
      type: ["string", "null"],
      enum: ["easy", "moderate", "challenging", null],
    },
    intendedFeeling: { type: ["string", "null"] },
    assumptions: { type: "array", items: { type: "string" } },
    preparationNotes: { type: "array", items: { type: "string" } },
  },
  required: [
    "title",
    "description",
    "whyItFits",
    "estimatedCostMin",
    "estimatedCostMax",
    "estimatedDurationMinutes",
    "locationText",
    "travelAssumption",
    "physicalDifficulty",
    "intendedFeeling",
    "assumptions",
    "preparationNotes",
  ],
} as const;

// NOTE: the provider schema sends a PLAIN array — no `minItems`/`maxItems`.
// Anthropic's structured-output subset rejects array `minItems` values other
// than 0 or 1 (and does not support `maxItems` here). The "exactly three"
// requirement is enforced after parsing by validateRecommendationBatch() (which
// rejects the whole batch when the count is wrong), and the system prompt asks
// the model for exactly RECOMMENDATION_BATCH_SIZE concepts. Do not re-add item
// count constraints to this schema — keep them in the application validator.
export const RECOMMENDATIONS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    recommendations: {
      type: "array",
      items: RECOMMENDATION_ITEM_SCHEMA,
    },
  },
  required: ["recommendations"],
} as const;

/** Mint a globally-unique opaque recommendation id. New on every batch. */
export function newRecommendationId(): string {
  return `rec_${randomUUID()}`;
}

/** Validate + normalize raw parsed provider JSON into a trusted batch of exactly
 * three recommendations, assigning fresh ids. Throws AiError("invalid_ai_output")
 * on ANY structural/range violation — the whole batch is rejected. */
export function validateRecommendationBatch(raw: unknown): ExperienceRecommendation[] {
  const fail = (m: string): never => {
    throw new AiError("invalid_ai_output", 422, m);
  };

  const arr = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).recommendations)
      ? ((raw as Record<string, unknown>).recommendations as unknown[])
      : fail("recommendation output was not an array");

  if ((arr as unknown[]).length !== RECOMMENDATION_BATCH_SIZE) {
    fail(`expected exactly ${RECOMMENDATION_BATCH_SIZE} recommendations`);
  }

  const reqStr = (v: unknown, label: string, cap: number): string => {
    if (typeof v !== "string" || !v.trim()) fail(`${label} is required`);
    return (v as string).trim().slice(0, cap);
  };
  const strOrNull = (v: unknown, cap: number): string | null =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, cap) : null;
  const numOrNull = (v: unknown, label: string): number | null => {
    if (v === null || v === undefined) return null;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) fail(`${label} must be a non-negative number`);
    return v as number;
  };
  const intOrNull = (v: unknown, label: string): number | null => {
    if (v === null || v === undefined) return null;
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) fail(`${label} must be a positive integer`);
    return v as number;
  };
  const enumOrNull = (v: unknown, allowed: string[], label: string): string | null => {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v !== "string" || !allowed.includes(v)) fail(`invalid ${label}`);
    return v as string;
  };
  const strArr = (v: unknown, label: string): string[] => {
    if (v == null) return [];
    if (!Array.isArray(v)) fail(`${label} must be an array of strings`);
    return (v as unknown[])
      .filter((x): x is string => typeof x === "string")
      .slice(0, CAP.arrayItems)
      .map((s) => s.slice(0, CAP.arrayItemChars));
  };

  return (arr as unknown[]).map((item): ExperienceRecommendation => {
    if (item == null || typeof item !== "object" || Array.isArray(item)) {
      fail("each recommendation must be an object");
    }
    const o = item as Record<string, unknown>;
    const costMin = numOrNull(o.estimatedCostMin, "estimatedCostMin");
    const costMax = numOrNull(o.estimatedCostMax, "estimatedCostMax");
    if (costMin != null && costMax != null && costMax < costMin) {
      fail("estimatedCostMax must be >= estimatedCostMin");
    }
    return {
      id: newRecommendationId(),
      title: reqStr(o.title, "title", CAP.title),
      description: reqStr(o.description, "description", CAP.description),
      whyItFits: reqStr(o.whyItFits, "whyItFits", CAP.whyItFits),
      estimatedCostMin: costMin,
      estimatedCostMax: costMax,
      estimatedDurationMinutes: intOrNull(o.estimatedDurationMinutes, "estimatedDurationMinutes"),
      locationText: strOrNull(o.locationText, CAP.locationText),
      travelAssumption: strOrNull(o.travelAssumption, CAP.travelAssumption),
      physicalDifficulty: enumOrNull(
        o.physicalDifficulty,
        DIFFICULTY,
        "physicalDifficulty",
      ) as ExperienceRecommendation["physicalDifficulty"],
      intendedFeeling: strOrNull(o.intendedFeeling, CAP.intendedFeeling),
      assumptions: strArr(o.assumptions, "assumptions"),
      preparationNotes: strArr(o.preparationNotes, "preparationNotes"),
    };
  });
}
