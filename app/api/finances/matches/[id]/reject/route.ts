/* POST /api/finances/matches/[id]/reject — Finance 1B.4A.
 * Owner-reject a suggestion (optional bounded reason). Mutates NO bill, income,
 * transfer, balance, movement, or imported transaction. The rejected row is kept
 * for audit. Ownership is server-derived from the suggestion id. */

import { NextResponse } from "next/server";
import { rejectMatchSuggestion, MatchError } from "@/lib/services/matching";
import { CURRENT_USER_ID } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Ctx) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid suggestion id." }, { status: 400 });
  let reason: string | null = null;
  try { const body = (await request.json().catch(() => ({}))) as { reason?: unknown }; if (typeof body.reason === "string") reason = body.reason; } catch { /* no body */ }
  try {
    return NextResponse.json({ suggestion: await rejectMatchSuggestion(CURRENT_USER_ID, id, reason) });
  } catch (e) {
    if (e instanceof MatchError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Could not reject the suggestion." }, { status: 500 });
  }
}
