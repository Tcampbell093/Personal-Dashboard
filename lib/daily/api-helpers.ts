/* =============================================================================
 * Daily Command Center — Slice 4: server-only API helpers.
 *
 * Owner is ALWAYS server-derived (`CURRENT_USER_ID`) — never read from the browser
 * (query/path/header/cookie/body). Shared context, capacity, key decoding, strict
 * body validation, no-store responses, and the sanitized error envelope. No route
 * here performs a consequential action.
 * ===========================================================================*/

import { NextResponse } from "next/server";
import { CURRENT_USER_ID } from "@/lib/auth";
import { localToday, appTimeZone } from "@/lib/time";
import { computeFinancialOutlook } from "@/lib/services/finances";
import { LifecycleError, type ResponseValue, type VerificationValue } from "./lifecycle";
import type { SignalContext } from "./contract";

export const OWNER_ID = CURRENT_USER_ID;
export const RESPONSE_VALUES: ResponseValue[] = ["pending", "accept", "defer", "reject", "not_relevant", "complete"];
export const VERIFICATION_VALUES: VerificationValue[] = ["unverified", "verified", "could_not_verify"];
export const KEY_MAX = 240;     // matches daily_recommendations.recommendation_key varchar(240)
export const NOTE_MAX = 500;
export const OUTCOME_NOTE_MAX = 1000;

/** Server-derived date/time context in America/New_York (spec §3/§4). */
export function ownerContext(now: Date = new Date()): { userId: number; ctx: SignalContext } {
  const today = localToday(now);
  return { userId: OWNER_ID, ctx: { today, timezone: appTimeZone(), now: now.toISOString() } };
}

/** Grounded available cash for capacity, or null when the finance service is unavailable
 * (the view then reports capacity "unknown" — never a false "affordable"). */
export async function availableCashFor(userId: number): Promise<number | null> {
  try { return (await computeFinancialOutlook(userId)).estimatedRemaining; }
  catch { return null; }
}

/** Decode + validate a recommendation key from the path. Two distinct keys are never
 * normalized into one; the exact decoded value is used. */
export function decodeKey(raw: string): string {
  let key: string;
  try { key = decodeURIComponent(raw); } catch { throw new LifecycleError(400, "Malformed recommendation key encoding."); }
  if (!key || !key.trim()) throw new LifecycleError(400, "Recommendation key is required.");
  if (key.length > KEY_MAX) throw new LifecycleError(400, "Recommendation key is too long.");
  return key;
}

/** Parse a mutation body as JSON; malformed JSON is a validation error, not a crash. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (!raw || !raw.trim()) return {};
  try { const v = JSON.parse(raw); if (v == null || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object"); return v as Record<string, unknown>; }
  catch { throw new LifecycleError(400, "Malformed JSON body."); }
}

/** STRICT policy: reject any field not in the allow-list — including userId/ownerId,
 * timestamps, row ids, fingerprints, scores, sourceRefs, verificationState-where-not-allowed. */
export function rejectUnknownFields(body: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) throw new LifecycleError(400, `Unexpected field(s): ${extra.slice(0, 5).join(", ")}. Ownership and lifecycle metadata are server-controlled.`);
}

export function optBoundedString(v: unknown, field: string, max: number): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") throw new LifecycleError(400, `${field} must be a string.`);
  if (v.length > max) throw new LifecycleError(400, `${field} exceeds ${max} characters.`);
  return v;
}

/** JSON response that is never cached (owner-specific + time-sensitive). */
export function noStore(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store, no-cache, must-revalidate", Vary: "Cookie" } });
}

/** Sanitized error envelope — never leaks stack traces, SQL, constraint names, or provider text. */
export function errorResponse(e: unknown, fallback = "Something went wrong."): NextResponse {
  if (e instanceof LifecycleError) return noStore({ error: e.message }, e.status);
  return noStore({ error: fallback }, 500);
}
