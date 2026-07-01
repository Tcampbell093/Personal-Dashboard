/* POST /api/finances/insights/[id]/dismiss — Finance 1B.5B.
 * Dismiss a calculated insight (by its deterministic period-scoped key). Changes
 * ONLY dismissal state — no finance-domain mutation. Owner-scoped. */

import { NextResponse } from "next/server";
import { dismissInsight, InsightError } from "@/lib/services/insights";
import { CURRENT_USER_ID } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Ctx) {
  const key = decodeURIComponent((await params).id);
  try {
    return NextResponse.json(await dismissInsight(CURRENT_USER_ID, key));
  } catch (e) {
    if (e instanceof InsightError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Could not dismiss the insight." }, { status: 500 });
  }
}
