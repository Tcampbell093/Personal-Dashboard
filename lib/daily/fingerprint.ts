/* =============================================================================
 * Daily Command Center — Slice 3: deterministic signal fingerprint.
 *
 * A stable sha256 over the MATERIALLY RELEVANT condition of a recommendation, so
 * lifecycle persistence can tell "the same condition, re-shown" from "a materially
 * changed condition that may supersede". Order-independent for reason codes and
 * source refs. Excludes anything volatile: timestamps, presentation count,
 * generated prose/wording, provider order, randomness. See spec §4.
 * ===========================================================================*/

import { createHash } from "node:crypto";
import type { DailySignal, SourceRef } from "./contract";

/** The bounded, material inputs the fingerprint is built from (spec §4). */
export interface FingerprintInput {
  key: string;
  domain: string;
  signalType: string;
  effectiveDate: string | null;
  urgency: string;
  confidence: string;
  estimatedCost: number | null;
  capacityReqs: { money: number | null; timeMinutes: number | null; scheduleConflict: boolean | null } | null;
  candidateAction: string | null;
  reasonCodes: string[];
  sourceRefs: SourceRef[];
}

const normRef = (r: SourceRef) => `${r.service}|${r.table ?? ""}|${r.id ?? ""}`;

/** Build the normalized, ordered material object (stable serialization). */
export function fingerprintObject(s: FingerprintInput): Record<string, unknown> {
  return {
    key: s.key,
    domain: s.domain,
    signalType: s.signalType,
    effectiveDate: s.effectiveDate ?? null,
    urgency: s.urgency,
    confidence: s.confidence,
    estimatedCost: s.estimatedCost ?? null,
    capacityReqs: s.capacityReqs
      ? { money: s.capacityReqs.money ?? null, timeMinutes: s.capacityReqs.timeMinutes ?? null, scheduleConflict: s.capacityReqs.scheduleConflict ?? null }
      : null,
    candidateAction: s.candidateAction ?? null,
    reasonCodes: [...(s.reasonCodes ?? [])].map(String).sort(),   // order-independent
    sourceRefs: [...(s.sourceRefs ?? [])].map(normRef).sort(),    // order-independent
  };
}

/** Deterministic sha256 hex fingerprint of the material condition. */
export function signalFingerprint(s: FingerprintInput): string {
  return createHash("sha256").update(JSON.stringify(fingerprintObject(s))).digest("hex");
}

/** Convenience: fingerprint a full DailySignal (uses only its material fields). */
export function fingerprintOfSignal(sig: DailySignal): string {
  return signalFingerprint({
    key: sig.key, domain: sig.domain, signalType: sig.signalType,
    effectiveDate: sig.effectiveDate, urgency: sig.urgency, confidence: sig.confidence,
    estimatedCost: sig.estimatedCost,
    capacityReqs: sig.capacityReqs ? { money: sig.capacityReqs.money ?? null, timeMinutes: sig.capacityReqs.timeMinutes ?? null, scheduleConflict: sig.capacityReqs.scheduleConflict ?? null } : null,
    candidateAction: sig.candidateAction, reasonCodes: sig.reasonCodes, sourceRefs: sig.sourceRefs,
  });
}
