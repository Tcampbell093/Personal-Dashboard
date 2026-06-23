/* Interpretation: provider structured-output JSON schema + application-level
 * validation. The schema constrains shape/enums at the provider; the validator
 * enforces what JSON Schema can't (non-negative ranges, lengths, date format)
 * and produces a trusted InterpretationResult. Any violation → AiError. */

import { AiError, type InterpretationResult } from "./provider";

export const INTERPRETATION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    availableDate: { type: ["string", "null"] },
    availableTimeText: { type: ["string", "null"] },
    budgetMax: { type: ["number", "null"] },
    startingLocation: { type: ["string", "null"] },
    maxTravelMiles: { type: ["integer", "null"] },
    maxTravelMinutes: { type: ["integer", "null"] },
    // Nullable enums as anyOf unions — Anthropic rejects `enum` combined with a
    // `["string","null"]` type array. String branch = string enum values only;
    // null branch = type:"null". App validation still enforces the same values.
    energyLevel: {
      anyOf: [
        { type: "string", enum: ["low", "medium", "high"] },
        { type: "null" },
      ],
    },
    desiredFeeling: { type: ["string", "null"] },
    maxPhysicalDifficulty: {
      anyOf: [
        { type: "string", enum: ["easy", "moderate", "challenging"] },
        { type: "null" },
      ],
    },
    interests: { type: "array", items: { type: "string" } },
    exclusions: { type: "array", items: { type: "string" } },
  },
  required: [
    "availableDate",
    "availableTimeText",
    "budgetMax",
    "startingLocation",
    "maxTravelMiles",
    "maxTravelMinutes",
    "energyLevel",
    "desiredFeeling",
    "maxPhysicalDifficulty",
    "interests",
    "exclusions",
  ],
} as const;

const ENERGY = ["low", "medium", "high"];
const DIFFICULTY = ["easy", "moderate", "challenging"];
const isDate = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Validate + normalize raw parsed JSON into a trusted InterpretationResult.
 * Throws AiError("invalid_ai_output") on any structural/range violation. */
export function validateInterpretation(raw: unknown): InterpretationResult {
  const fail = (m: string): never => {
    throw new AiError("invalid_ai_output", 422, m);
  };
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return fail("interpretation output was not an object");
  }
  const o = raw as Record<string, unknown>;

  const numOrNull = (v: unknown, label: string): number | null => {
    if (v === null || v === undefined) return null;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) fail(`${label} must be a non-negative number`);
    return v as number;
  };
  const intOrNull = (v: unknown, label: string): number | null => {
    if (v === null || v === undefined) return null;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) fail(`${label} must be a non-negative integer`);
    return v as number;
  };
  const enumOrNull = (v: unknown, allowed: string[], label: string): string | null => {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v !== "string" || !allowed.includes(v)) fail(`invalid ${label}`);
    return v as string;
  };
  const strArr = (v: unknown): string[] => {
    if (v == null) return [];
    if (!Array.isArray(v)) fail("expected an array of strings");
    return (v as unknown[])
      .filter((x): x is string => typeof x === "string")
      .slice(0, 20)
      .map((s) => s.slice(0, 80));
  };
  const strOrNull = (v: unknown, cap: number): string | null =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, cap) : null;

  if (o.availableDate != null && !isDate(o.availableDate)) fail("invalid availableDate");

  return {
    availableDate: isDate(o.availableDate) ? o.availableDate : null,
    availableTimeText: strOrNull(o.availableTimeText, 120),
    budgetMax: numOrNull(o.budgetMax, "budgetMax"),
    startingLocation: strOrNull(o.startingLocation, 200),
    maxTravelMiles: intOrNull(o.maxTravelMiles, "maxTravelMiles"),
    maxTravelMinutes: intOrNull(o.maxTravelMinutes, "maxTravelMinutes"),
    energyLevel: enumOrNull(o.energyLevel, ENERGY, "energyLevel") as InterpretationResult["energyLevel"],
    desiredFeeling: strOrNull(o.desiredFeeling, 200),
    maxPhysicalDifficulty: enumOrNull(
      o.maxPhysicalDifficulty,
      DIFFICULTY,
      "maxPhysicalDifficulty",
    ) as InterpretationResult["maxPhysicalDifficulty"],
    interests: strArr(o.interests),
    exclusions: strArr(o.exclusions),
  };
}
