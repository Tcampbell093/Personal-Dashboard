/* GET /api/daily — Daily Command Center Slice 4.
 * Owner-scoped, READ-ONLY. Collects signals (failure-isolated), loads lifecycle
 * suppression, ranks, and returns a bounded public DailyBriefView. Performs NO
 * writes — presentation is recorded only via the explicit POST .../present route.
 * Owner is server-derived; the browser never supplies it. Response is no-store. */

import { runDailySelection, getActiveRecommendation, loadSuppressedKeys } from "@/lib/daily/lifecycle";
import { buildDailyBriefView } from "@/lib/daily/view";
import { ownerContext, availableCashFor, noStore, errorResponse } from "@/lib/daily/api-helpers";

export const dynamic = "force-dynamic"; // owner-specific + time-sensitive; never statically cached

export async function GET() {
  try {
    const { userId, ctx } = ownerContext();
    const availableCash = await availableCashFor(userId);
    // Read-only: present is NOT passed, so no lifecycle row is written on a GET.
    const run = await runDailySelection(userId, ctx, { availableCash });
    const suppressedKeys = await loadSuppressedKeys(userId, ctx.today);
    const moveKey = run.selection.recommendedMove.signalKey;
    const activeMoveRow = moveKey ? await getActiveRecommendation(userId, moveKey) : null;
    const view = buildDailyBriefView({
      today: ctx.today, generatedAt: ctx.now, signals: run.collected.signals,
      selection: run.selection, suppressedKeys, availableCash, activeMoveRow,
    });
    return noStore(view);
  } catch {
    return errorResponse(null, "Could not load the daily command center.");
  }
}
