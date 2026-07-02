/* POST /api/daily/recommendations/[key]/present — DCC Slice 4.
 * Explicitly record that the recommended move was PRESENTED to the owner. The key
 * must be EXACTLY the currently-selected recommended-move key (recomputed on the
 * server) — arbitrary/stale/suppressed/below-threshold/no-longer-current keys are
 * rejected, so the browser cannot invent a key and persist it. Owner-scoped; no-store. */

import { runDailySelection, presentRecommendation, buildSnapshot, LifecycleError, getActiveRecommendation } from "@/lib/daily/lifecycle";
import { toPublicLifecycle } from "@/lib/daily/view";
import { ownerContext, availableCashFor, decodeKey, noStore, errorResponse } from "@/lib/daily/api-helpers";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ key: string }> };

export async function POST(_request: Request, { params }: Ctx) {
  try {
    const key = decodeKey((await params).key);
    const { userId, ctx } = ownerContext();
    const availableCash = await availableCashFor(userId);
    // Recompute the CURRENT selection (read-only) and confirm the key is the selected move.
    const run = await runDailySelection(userId, ctx, { availableCash });
    const currentKey = run.selection.recommendedMove.signalKey;
    if (!currentKey) throw new LifecycleError(409, "There is no recommended move to present right now.");
    if (currentKey !== key) throw new LifecycleError(409, "That recommendation is not the currently recommended move.");
    const sig = run.collected.signals.find((s) => s.key === key);
    if (!sig) throw new LifecycleError(409, "That recommendation is no longer available.");
    // Persist/reuse/supersede; increment presentation exactly once for this explicit request.
    await presentRecommendation(userId, sig, buildSnapshot(sig, run.selection.recommendedMove.reasonSelected), ctx, { incrementPresentation: true });
    const row = await getActiveRecommendation(userId, key);
    return noStore({ lifecycle: toPublicLifecycle(row) });
  } catch (e) {
    return errorResponse(e, "Could not record presentation.");
  }
}
