/* =============================================================================
 * Daily Command Center — Slice 2: failure-isolated orchestration.
 *
 * `collectDailySignals` calls every grounded Slice 1 provider independently
 * (`Promise.allSettled`), validates each returned signal against the Slice 1
 * contract, and returns valid signals + a degraded-provider list + invalid-signal
 * diagnostics. READ-ONLY; no writes, no external/AI call, no persistence.
 *
 * A REQUEST-SCOPED memoized credit overview is built per run and shared with the
 * credit / goals / stale-score providers so `computeCreditOverview` runs once per
 * (userId, today) — no global/cross-user cache, no persistence (see contract
 * `SignalContext.sharedCredit`). Providers remain independently callable.
 * ===========================================================================*/

import { type DailySignal, type DailyDomain, type SignalContext, validateSignal } from "./contract";
import { DAILY_SIGNAL_PROVIDERS } from "./providers";
import { computeCreditOverview, type CreditOverview } from "@/lib/services/credit";

export interface DegradedDomain { domain: DailyDomain; error: string }
export interface InvalidSignal { domain: DailyDomain; key: string; problems: string[] }

export interface CollectedSignals {
  signals: DailySignal[];        // contract-valid signals, in provider order
  degraded: DegradedDomain[];    // providers that threw (their domain is degraded, others preserved)
  invalid: InvalidSignal[];      // signals that failed contract validation (excluded, diagnosed)
  context: SignalContext;
  collectedAt: string;           // ctx.now (informational)
}

/** Redact to a bounded, nonsecret error string — never log provider payloads/secrets. */
function safeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Build a request-scoped memoized credit overview keyed implicitly by (userId, today). */
export function makeSharedCredit(userId: number, today: string): () => Promise<CreditOverview> {
  let cached: Promise<CreditOverview> | null = null;
  return () => (cached ??= computeCreditOverview(userId, { now: today }));
}

export async function collectDailySignals(userId: number, ctx: SignalContext): Promise<CollectedSignals> {
  // One shared credit computation per run (correctness-preserving optimization).
  const runCtx: SignalContext = { ...ctx, sharedCredit: ctx.sharedCredit ?? makeSharedCredit(userId, ctx.today) };

  const results = await Promise.allSettled(
    DAILY_SIGNAL_PROVIDERS.map((p) => p.getDailySignals(userId, runCtx)),
  );

  const signals: DailySignal[] = [];
  const degraded: DegradedDomain[] = [];
  const invalid: InvalidSignal[] = [];

  results.forEach((r, i) => {
    const domain = DAILY_SIGNAL_PROVIDERS[i].domain;
    if (r.status === "rejected") { degraded.push({ domain, error: safeError(r.reason) }); return; }
    // A provider that returns a non-array is treated as a degraded domain (defensive).
    if (!Array.isArray(r.value)) { degraded.push({ domain, error: "provider returned a non-array result" }); return; }
    for (const s of r.value) {
      const problems = validateSignal(s);
      if (problems.length === 0) signals.push(s);
      else invalid.push({ domain, key: (s && s.key) || "(nokey)", problems });
    }
  });

  return { signals, degraded, invalid, context: ctx, collectedAt: ctx.now };
}
