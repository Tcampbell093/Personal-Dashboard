/* POST /api/finances/matches/[id]/confirm — Finance 1B.4A.
 * Owner-confirm a suggestion. Ownership + eligibility are SERVER-derived (the
 * browser supplies only the suggestion id). Applies the existing approved
 * workflow atomically (with compensating revert on failure); transfer pairs and
 * linked-account income fail closed. Returns the updated view. */

import { NextResponse } from "next/server";
import { confirmMatchSuggestion, MatchError } from "@/lib/services/matching";
import { CURRENT_USER_ID } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Ctx) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid suggestion id." }, { status: 400 });
  try {
    return NextResponse.json({ suggestion: await confirmMatchSuggestion(CURRENT_USER_ID, id) });
  } catch (e) {
    if (e instanceof MatchError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Could not confirm the suggestion." }, { status: 500 });
  }
}
