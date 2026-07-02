/* GET /api/daily — Daily Command Center Slice 4.
 * Owner-scoped, READ-ONLY. Collects signals (failure-isolated), loads lifecycle
 * suppression, ranks, and returns a bounded public DailyBriefView. Performs NO
 * writes — presentation is recorded only via the explicit POST .../present route.
 * Owner is server-derived; the browser never supplies it. Response is no-store. */

import { runDailySelection, getActiveRecommendation, suppressedKeySet } from "@/lib/daily/lifecycle";
import { fingerprintOfSignal } from "@/lib/daily/fingerprint";
import { buildDailyBriefView } from "@/lib/daily/view";
import { ownerContext, availableCashFor, noStore, errorResponse } from "@/lib/daily/api-helpers";

export const dynamic = "force-dynamic"; // owner-specific + time-sensitive; never statically cached

export async function GET() {
  try {
    const { userId, ctx } = ownerContext();
    const availableCash = await availableCashFor(userId);
    // Read-only: present is NOT passed, so no lifecycle row is written on a GET.
    const run = await runDailySelection(userId, ctx, { availableCash });
    // ONE fingerprint-aware suppression result feeds BOTH ranking and Today — never a second
    // fingerprint-less lookup that would re-suppress a materially-changed accepted/rejected/completed key.
    const suppressedKeys = suppressedKeySet(run.suppression);
    // Attach lifecycle to the selected move ONLY when the stored row still describes the CURRENT
    // material condition (fingerprint match). A row from a prior condition must not surface a stale
    // accept/complete/reject as the new move's state — leave it null until an explicit present supersedes.
    const moveKey = run.selection.recommendedMove.signalKey;
    let activeMoveRow = null;
    if (moveKey) {
      const currentSignal = run.collected.signals.find((s) => s.key === moveKey);
      const row = await getActiveRecommendation(userId, moveKey);
      if (row && currentSignal && row.signalFingerprint === fingerprintOfSignal(currentSignal)) activeMoveRow = row;
    }
    const view = buildDailyBriefView({
      today: ctx.today, generatedAt: ctx.now, signals: run.collected.signals,
      selection: run.selection, suppressedKeys, availableCash, activeMoveRow,
    });
    return noStore(view);
  } catch {
    return errorResponse(null, "Could not load the daily command center.");
  }
}
