/* GET /api/finances/matches — Finance 1B.4A.
 * Owner-scoped, read-only list of transaction-match SUGGESTIONS. Bounded filters:
 * status (pending|confirmed|rejected, default pending) + type. Mutates nothing;
 * exposes no provider identifiers or secrets. */

import { NextResponse } from "next/server";
import { getMatchSuggestionViews } from "@/lib/services/matching";
import { CURRENT_USER_ID } from "@/lib/auth";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? undefined;
  const type = url.searchParams.get("type") ?? undefined;
  try {
    return NextResponse.json({ suggestions: await getMatchSuggestionViews(CURRENT_USER_ID, { status: status ?? "pending", type }) });
  } catch {
    return NextResponse.json({ error: "Could not load suggestions." }, { status: 500 });
  }
}
