/* =============================================================================
 * Daily Command Center — Slice 3: recommendation LIFECYCLE persistence.
 *
 * Persists ONLY the lifecycle of a recommended move (presentation, owner response,
 * suppression, supersession). It stores NO calculated DailySignal[], ranked
 * arrays, source-domain facts, or generated briefs — only bounded `sourceRefs`
 * (references) + a bounded presentation `snapshot`. Every read/write is
 * owner-scoped. No API/UI/AI/Home/notifications here.
 *
 * neon-http has no interactive transactions, so supersession deactivates the old
 * row via `supersededAt` FIRST (no new-id circularity), inserts the new active
 * row, then links `supersededById`; the live-only partial unique index
 * (`daily_recommendations_active_uq`) is the race guard (23505 → return winner).
 * ===========================================================================*/

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { dailyRecommendations } from "@/db/schema";
import type { DailySignal, SignalContext } from "./contract";
import { isoAddDays, dayDiff } from "./contract";
import { fingerprintOfSignal } from "./fingerprint";
import { collectDailySignals, type CollectedSignals } from "./orchestrator";
import { rankSignals, type DailySelection, type RankingContext } from "./ranking";

export const REJECT_COOLDOWN_DAYS = 14;
export const NOT_RELEVANT_COOLDOWN_DAYS = 90;

export type ResponseValue = "pending" | "accept" | "defer" | "reject" | "not_relevant" | "complete";
export type VerificationValue = "unverified" | "verified" | "could_not_verify";
const RESPONDABLE: ResponseValue[] = ["accept", "defer", "reject", "not_relevant", "complete"];
const VERIFICATIONS: VerificationValue[] = ["unverified", "verified", "could_not_verify"];

export type LifecycleRow = typeof dailyRecommendations.$inferSelect;

export class LifecycleError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.name = "LifecycleError"; this.status = status; }
}
const isUniqueViolation = (e: unknown) => typeof e === "object" && e != null && (e as { code?: string }).code === "23505";
const dateOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/* ------------------------------------------------ bounded snapshot -------- */
export interface RecommendationSnapshot {
  title: string; summary: string; evidence: string;
  estimatedUpside: string | null; estimatedDownside: string | null; estimatedCost: number | null;
  timeRequired: string | null; urgency: string; confidence: string;
  candidateAction: string | null; requiredVerification: string | null; staleDate: string;
  reasonSelected: string; signalKey: string;
}
/** Extract ONLY the bounded, allowed presentation fields — never payloads/secrets. */
export function buildSnapshot(sig: DailySignal, reasonSelected: string): RecommendationSnapshot {
  const s = (v: string | null | undefined, max = 500) => (v == null ? null : String(v).slice(0, max));
  return {
    title: s(sig.title, 200) ?? "", summary: s(sig.summary) ?? "", evidence: s(sig.evidence) ?? "",
    estimatedUpside: s(sig.estimatedUpside), estimatedDownside: s(sig.estimatedDownside), estimatedCost: sig.estimatedCost ?? null,
    timeRequired: s(sig.timeRequired, 60), urgency: sig.urgency, confidence: sig.confidence,
    candidateAction: s(sig.candidateAction), requiredVerification: s(sig.requiredVerification), staleDate: sig.staleDate,
    reasonSelected: s(reasonSelected, 80) ?? "", signalKey: sig.key,
  };
}

/* ------------------------------------------------ queries ---------------- */
async function activeRow(userId: number, recommendationKey: string): Promise<LifecycleRow | null> {
  const [row] = await db.select().from(dailyRecommendations)
    .where(and(eq(dailyRecommendations.userId, userId), eq(dailyRecommendations.recommendationKey, recommendationKey), isNull(dailyRecommendations.deletedAt), isNull(dailyRecommendations.supersededAt)))
    .limit(1);
  return row ?? null;
}
async function ownedRow(userId: number, id: number): Promise<LifecycleRow> {
  if (!Number.isInteger(id) || id <= 0) throw new LifecycleError(400, "Invalid id.");
  const [row] = await db.select().from(dailyRecommendations).where(and(eq(dailyRecommendations.userId, userId), eq(dailyRecommendations.id, id))).limit(1);
  if (!row) throw new LifecycleError(404, "Not found.");
  return row;
}

/* ------------------------------------------------ present / reuse / supersede */
export interface PresentOpts { incrementPresentation?: boolean; now?: Date; }
/** Present-or-reuse-or-supersede a selected recommended move (spec §5). Idempotent
 * under identical calls when presentation increment is not requested. */
export async function presentRecommendation(userId: number, sig: DailySignal, snapshot: RecommendationSnapshot, ctx: SignalContext, opts: PresentOpts = {}): Promise<LifecycleRow> {
  const now = opts.now ?? new Date();
  const fp = fingerprintOfSignal(sig);
  const existing = await activeRow(userId, sig.key);

  if (existing && existing.signalFingerprint === fp) {
    // Same material condition → reuse; never a duplicate row. Preserve owner response.
    const [row] = await db.update(dailyRecommendations)
      .set({ lastPresentedAt: now, snapshot, presentedCount: existing.presentedCount + (opts.incrementPresentation ? 1 : 0), updatedAt: now })
      .where(and(eq(dailyRecommendations.userId, userId), eq(dailyRecommendations.id, existing.id))).returning();
    return row;
  }

  if (existing && existing.response === "pending") {
    // Pending row, materially changed → update in place (no owner decision to preserve).
    const [row] = await db.update(dailyRecommendations)
      .set({ signalFingerprint: fp, snapshot, domain: sig.domain, signalType: sig.signalType, sourceRefs: sig.sourceRefs, lastPresentedAt: now, presentedCount: existing.presentedCount + (opts.incrementPresentation ? 1 : 0), updatedAt: now })
      .where(and(eq(dailyRecommendations.userId, userId), eq(dailyRecommendations.id, existing.id))).returning();
    return row;
  }

  if (existing) {
    // Active row with a DIFFERENT fingerprint and a real response → supersede ATOMICALLY.
    return supersedeAtomic(userId, existing.id, sig, snapshot, fp, ctx, now);
  }

  // No active row → create pending.
  return insertActive(userId, sig, snapshot, fp, ctx, now);
}

/** GENUINELY ATOMIC supersession: ONE SQL statement — a `SELECT` of the
 * `supersede_daily_recommendation` plpgsql function (migration `0023`). The whole
 * call is a single statement, so PostgreSQL rolls back ALL of (deactivate old +
 * insert new + link old→new) on any failure (proven by verify-daily-slice3 [S2]).
 * Inside the function statements run SEQUENTIALLY (unlike writable CTEs, which are
 * snapshot-isolated and cannot modify the same row twice), so the old row is
 * deactivated first, the insert then sees it inactive (no partial-unique conflict),
 * and the link is applied. The live-only partial unique index remains the
 * concurrency race guard (23505 or a NULL return → return the current active winner).
 * neon-http needs no interactive transaction. All owner-scoped. */
async function supersedeAtomic(userId: number, oldId: number, sig: DailySignal, snapshot: RecommendationSnapshot, fp: string, ctx: SignalContext, now: Date): Promise<LifecycleRow> {
  const ts = now.toISOString();
  try {
    const res = await db.execute(sql`
      SELECT supersede_daily_recommendation(
        ${userId}, ${oldId}, ${sig.key}, ${sig.domain}, ${sig.signalType},
        ${JSON.stringify(sig.sourceRefs)}::jsonb, ${fp}, ${ctx.today}::date, ${JSON.stringify(snapshot)}::jsonb, ${ts}::timestamptz
      ) AS new_id`);
    const rows = (res as unknown as { rows?: { new_id: number | null }[] }).rows ?? (res as unknown as { new_id: number | null }[]);
    const newId = Array.isArray(rows) && rows[0] ? rows[0].new_id : null;
    if (newId != null) { const [row] = await db.select().from(dailyRecommendations).where(eq(dailyRecommendations.id, newId)); return row; }
    // NULL → old row was already inactive (a concurrent supersession won); return the active winner.
    const winner = await activeRow(userId, sig.key);
    if (winner) return winner;
    throw new LifecycleError(409, "Supersession could not resolve an active row.");
  } catch (e) {
    if (isUniqueViolation(e)) { const winner = await activeRow(userId, sig.key); if (winner) return winner; } // concurrency race guard
    throw e;
  }
}

async function insertActive(userId: number, sig: DailySignal, snapshot: RecommendationSnapshot, fp: string, ctx: SignalContext, now: Date): Promise<LifecycleRow> {
  try {
    const [row] = await db.insert(dailyRecommendations).values({
      userId, recommendationKey: sig.key, domain: sig.domain, signalType: sig.signalType,
      sourceRefs: sig.sourceRefs, signalFingerprint: fp, presentedOn: ctx.today, lastPresentedAt: now,
      presentedCount: 1, snapshot, response: "pending", verificationState: "unverified",
    }).returning();
    return row;
  } catch (e) {
    if (isUniqueViolation(e)) { const r = await activeRow(userId, sig.key); if (r) return r; } // concurrent winner
    throw e;
  }
}

/* ------------------------------------------------ respond / correct ------- */
export interface RespondOpts { note?: string | null; deferUntil?: string | null; today?: string; now?: Date; }
/** Record an owner response on the active row (spec §5). Superseded/deleted rows
 * are not active and cannot be responded to here (use reopen/correct). */
export async function respondToRecommendation(userId: number, recommendationKey: string, response: ResponseValue, opts: RespondOpts = {}): Promise<LifecycleRow> {
  const now = opts.now ?? new Date();
  const today = opts.today ?? now.toISOString().slice(0, 10);
  const row = await activeRow(userId, recommendationKey);
  if (!row) throw new LifecycleError(404, "No active recommendation for that key.");
  // `pending` = explicit reopen (spec §3C). Idempotent when already pending.
  if (response === "pending") return row.response === "pending" ? row : reopenRecommendation(userId, row.id, { now });
  if (!RESPONDABLE.includes(response)) throw new LifecycleError(400, `Invalid response: ${response}.`);
  // IDEMPOTENCY (spec §11): an identical response + identical params is a no-op — it must NOT
  // replace `respondedAt`/`completedAt` or re-extend a cooldown. A changed response/param is a
  // genuine correction and updates the row. Implemented in the service so all callers share it.
  if (row.response === response) {
    const noteEq = (row.responseNote ?? null) === (opts.note ?? null);
    const deferEq = response !== "defer" || ((row.deferUntil as unknown as string | null) ?? null) === (opts.deferUntil ?? null);
    if (noteEq && deferEq) return row;
  }
  return applyResponse(userId, row.id, response, opts, now, today);
}

/** Read the owner's ACTIVE (live, non-superseded) lifecycle row for a key, or null.
 * Owner-scoped — a key belonging only to another owner returns null (no existence leak). */
export async function getActiveRecommendation(userId: number, recommendationKey: string): Promise<LifecycleRow | null> {
  return activeRow(userId, recommendationKey);
}

export interface OutcomeOpts { outcomeNote?: string | null; verificationState?: VerificationValue; now?: Date; }
/** Record a bounded outcome and/or verification on the owner's COMPLETED active row
 * (spec §12). Owner-scoped; requires `complete`; rejects an empty request; verification
 * is a recorded assertion only (NO automated verification). Idempotent on identical retry. */
export async function recordRecommendationOutcome(userId: number, recommendationKey: string, opts: OutcomeOpts): Promise<LifecycleRow> {
  const now = opts.now ?? new Date();
  const hasNote = opts.outcomeNote !== undefined;
  const hasVer = opts.verificationState !== undefined;
  if (!hasNote && !hasVer) throw new LifecycleError(400, "Provide an outcome note, a verification state, or both.");
  if (hasVer && !VERIFICATIONS.includes(opts.verificationState as VerificationValue)) throw new LifecycleError(400, "Invalid verification state.");
  const row = await activeRow(userId, recommendationKey);
  if (!row) throw new LifecycleError(404, "No active recommendation for that key.");
  if (row.response !== "complete") throw new LifecycleError(409, "Outcome can only be recorded on a completed recommendation.");
  const note = hasNote ? (opts.outcomeNote == null || opts.outcomeNote === "" ? null : String(opts.outcomeNote).slice(0, 1000)) : (row.outcomeNote ?? null);
  const ver = hasVer ? (opts.verificationState as VerificationValue) : (row.verificationState as VerificationValue);
  if ((row.outcomeNote ?? null) === note && row.verificationState === ver) return row; // idempotent
  const [updated] = await db.update(dailyRecommendations).set({ outcomeNote: note, verificationState: ver, updatedAt: now }).where(and(eq(dailyRecommendations.userId, userId), eq(dailyRecommendations.id, row.id))).returning();
  return updated;
}

async function applyResponse(userId: number, id: number, response: ResponseValue, opts: RespondOpts, now: Date, today: string): Promise<LifecycleRow> {
  const patch: Partial<LifecycleRow> = { response, respondedAt: now, updatedAt: now, responseNote: opts.note ?? null };
  if (response === "defer") {
    if (!opts.deferUntil) throw new LifecycleError(400, "defer requires deferUntil.");
    if (dayDiff(opts.deferUntil, today) <= 0) throw new LifecycleError(400, "deferUntil must be in the future.");
    patch.deferUntil = opts.deferUntil;
  } else patch.deferUntil = null;
  if (response === "complete") { patch.completedAt = now; patch.verificationState = "unverified"; }
  else patch.completedAt = null;
  const [updated] = await db.update(dailyRecommendations).set(patch).where(and(eq(dailyRecommendations.userId, userId), eq(dailyRecommendations.id, id))).returning();
  return updated;
}

/** Explicit correction: change one response to another on the OWNER's active row. */
export async function correctResponse(userId: number, id: number, response: ResponseValue, opts: RespondOpts = {}): Promise<LifecycleRow> {
  if (!RESPONDABLE.includes(response)) throw new LifecycleError(400, `Invalid response: ${response}.`);
  const now = opts.now ?? new Date();
  const today = opts.today ?? now.toISOString().slice(0, 10);
  const row = await ownedRow(userId, id);
  if (row.deletedAt) throw new LifecycleError(409, "Cannot correct a deleted row.");
  if (row.supersededAt) throw new LifecycleError(409, "Cannot correct a superseded row.");
  return applyResponse(userId, id, response, opts, now, today);
}

/** Explicit reopen: return the owner's active row to `pending`, clearing response state. */
export async function reopenRecommendation(userId: number, id: number, opts: { now?: Date } = {}): Promise<LifecycleRow> {
  const now = opts.now ?? new Date();
  const row = await ownedRow(userId, id);
  if (row.deletedAt) throw new LifecycleError(409, "Cannot reopen a deleted row.");
  if (row.supersededAt) throw new LifecycleError(409, "Cannot reopen a superseded row.");
  const [updated] = await db.update(dailyRecommendations)
    .set({ response: "pending", respondedAt: null, deferUntil: null, completedAt: null, outcomeNote: null, verificationState: "unverified", updatedAt: now })
    .where(and(eq(dailyRecommendations.userId, userId), eq(dailyRecommendations.id, id))).returning();
  return updated;
}

/* ------------------------------------------------ suppression (spec §6) --- */
export interface SuppressionDiag {
  recommendationKey: string; rowId: number; response: ResponseValue; reason: string;
  suppressedUntil: string | null; // the LAST date on which the item is suppressed (inclusive)
  eligibleOn: string | null;      // the FIRST date on which the item is eligible again (exclusive boundary)
  fingerprint: string;
}

/** Currently-suppressed recommendation keys + structured reasons for an owner/date.
 * `currentFingerprints` (key → fingerprint of the live signal) lets a materially
 * changed condition un-suppress accept/reject/not_relevant/complete; when omitted,
 * fingerprints are assumed unchanged (conservative suppression). */
export async function getSuppression(userId: number, today: string, currentFingerprints?: Map<string, string>): Promise<SuppressionDiag[]> {
  const rows = await db.select().from(dailyRecommendations)
    .where(and(eq(dailyRecommendations.userId, userId), isNull(dailyRecommendations.deletedAt), isNull(dailyRecommendations.supersededAt)));
  const out: SuppressionDiag[] = [];
  const unchanged = (r: LifecycleRow) => { const cur = currentFingerprints?.get(r.recommendationKey); return cur == null ? true : cur === r.signalFingerprint; };
  const diag = (r: LifecycleRow, reason: string, until: string | null, eligibleOn: string | null) => out.push({ recommendationKey: r.recommendationKey, rowId: r.id, response: r.response as ResponseValue, reason, suppressedUntil: until, eligibleOn, fingerprint: r.signalFingerprint });

  for (const r of rows) {
    switch (r.response as ResponseValue) {
      case "pending": break; // eligible
      case "accept": if (unchanged(r)) diag(r, "accepted_active", null, null); break;
      case "defer": {
        // deferUntil is a date column (string). Suppress through deferUntil INCLUSIVE (time-based,
        // fingerprint-independent per spec §6); eligible the FOLLOWING day (deferUntil + 1).
        const boundary = (r.deferUntil as unknown as string) ?? null;
        if (boundary && dayDiff(boundary, today) >= 0) diag(r, "deferred_until_boundary", boundary, isoAddDays(boundary, 1));
        break;
      }
      case "reject": {
        // EXCLUSIVE cooldown: eligibleOn = respondedDate + 14; suppress only when today < eligibleOn.
        // (respondedDate .. respondedDate+13 suppressed → 14 calendar days; eligible on +14.)
        const from = dateOf(r.respondedAt);
        const eligibleOn = from ? isoAddDays(from, REJECT_COOLDOWN_DAYS) : null;
        if (eligibleOn && dayDiff(eligibleOn, today) > 0 && unchanged(r)) diag(r, "rejected_cooldown_14d", isoAddDays(eligibleOn, -1), eligibleOn);
        break;
      }
      case "not_relevant": {
        // EXCLUSIVE cooldown: eligibleOn = respondedDate + 90; suppress only when today < eligibleOn.
        const from = dateOf(r.respondedAt);
        const eligibleOn = from ? isoAddDays(from, NOT_RELEVANT_COOLDOWN_DAYS) : null;
        if (eligibleOn && dayDiff(eligibleOn, today) > 0 && unchanged(r)) diag(r, "not_relevant_cooldown_90d", isoAddDays(eligibleOn, -1), eligibleOn);
        break;
      }
      case "complete": if (unchanged(r)) diag(r, "completed_unchanged", null, null); break;
    }
  }
  return out;
}

export const suppressedKeySet = (diags: SuppressionDiag[]): Set<string> => new Set(diags.map((d) => d.recommendationKey));

/** Convenience: load the owner's suppressed key set for ranking (spec §9 helper). */
export async function loadSuppressedKeys(userId: number, today: string, currentFingerprints?: Map<string, string>): Promise<Set<string>> {
  return suppressedKeySet(await getSuppression(userId, today, currentFingerprints));
}

/* ------------------------------------------------ Slice 2 coordinator ----- */
export interface DailyRunResult { collected: CollectedSignals; suppression: SuppressionDiag[]; selection: DailySelection; presented: LifecycleRow | null; }
export interface DailyRunOpts { present?: boolean; availableCash?: number | null; }
/** Read-only by default (spec §9): collect → load suppression → rank. Writes a
 * lifecycle row ONLY when `present: true` and a recommended move was selected. */
export async function runDailySelection(userId: number, ctx: SignalContext, opts: DailyRunOpts = {}): Promise<DailyRunResult> {
  const collected = await collectDailySignals(userId, ctx);
  const fpMap = new Map(collected.signals.map((s) => [s.key, fingerprintOfSignal(s)]));
  const suppression = await getSuppression(userId, ctx.today, fpMap);
  const rankCtx: RankingContext = { today: ctx.today, availableCash: opts.availableCash ?? null, suppressedKeys: suppressedKeySet(suppression) };
  const selection = rankSignals(collected, rankCtx);
  let presented: LifecycleRow | null = null;
  if (opts.present && selection.recommendedMove.signalKey) {
    const sig = collected.signals.find((s) => s.key === selection.recommendedMove.signalKey);
    if (sig) presented = await presentRecommendation(userId, sig, buildSnapshot(sig, selection.recommendedMove.reasonSelected), ctx, { incrementPresentation: true });
  }
  return { collected, suppression, selection, presented };
}
