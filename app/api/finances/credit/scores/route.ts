/* /api/finances/credit/scores — Finance 1C.0A. Owner-entered score snapshots.
 *   GET  → all snapshots (newest first, historical preserved).
 *   POST → add a snapshot (source + as-of date required; range validated; idempotent). */

import { NextResponse } from "next/server";
import { listScores, createScore, CreditError } from "@/lib/services/credit";
import { CURRENT_USER_ID } from "@/lib/auth";

export async function GET() {
  try { return NextResponse.json({ scores: await listScores(CURRENT_USER_ID) }); }
  catch { return NextResponse.json({ error: "Could not load scores." }, { status: 500 }); }
}

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid body." }, { status: 400 }); }
  try { return NextResponse.json({ score: await createScore(CURRENT_USER_ID, body as never) }); }
  catch (e) {
    if (e instanceof CreditError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Could not create the score snapshot." }, { status: 500 });
  }
}
