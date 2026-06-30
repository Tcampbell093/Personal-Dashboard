/* POST /api/finances/matches/generate — Finance 1B.4A.
 * Owner-scoped deterministic suggestion generation. Mutates NO finance record
 * (no bill/income/transfer/balance/movement/snapshot/cursor) — it only upserts
 * suggestion rows. Returns counts + the current pending suggestion views. */

import { NextResponse } from "next/server";
import { generateMatchSuggestions, getMatchSuggestionViews } from "@/lib/services/matching";
import { CURRENT_USER_ID } from "@/lib/auth";

export async function POST() {
  try {
    const result = await generateMatchSuggestions(CURRENT_USER_ID);
    const suggestions = await getMatchSuggestionViews(CURRENT_USER_ID, { status: "pending" });
    return NextResponse.json({ ...result, suggestions });
  } catch {
    return NextResponse.json({ error: "Could not generate suggestions." }, { status: 500 });
  }
}
