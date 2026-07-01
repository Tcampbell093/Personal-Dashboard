/* /api/finances/categories/rules — Finance 1B.5A. Owner-approved merchant rules.
 *   GET  → rules + how many transactions each affects.
 *   POST → explicitly create a rule (suggest|auto) + optional apply-to-existing. */

import { NextResponse } from "next/server";
import { listRules, createRule, CategoryError } from "@/lib/services/categories";
import { CURRENT_USER_ID } from "@/lib/auth";

export async function GET() {
  try { return NextResponse.json({ rules: await listRules(CURRENT_USER_ID) }); }
  catch { return NextResponse.json({ error: "Could not load rules." }, { status: 500 }); }
}

export async function POST(request: Request) {
  let body: { matchValue?: unknown; matchType?: unknown; categoryId?: unknown; behavior?: unknown; applyToExisting?: unknown } = {};
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid body." }, { status: 400 }); }
  const categoryId = Number(body.categoryId);
  if (!Number.isInteger(categoryId) || categoryId <= 0) return NextResponse.json({ error: "A category is required." }, { status: 400 });
  const matchType = body.matchType === "description_contains" || body.matchType === "description_starts_with" ? body.matchType : "exact_normalized_merchant";
  const behavior = body.behavior === "auto" ? "auto" : "suggest"; // default suggest
  try {
    return NextResponse.json({ rule: await createRule(CURRENT_USER_ID, { matchValue: String(body.matchValue ?? ""), matchType, categoryId, behavior, applyToExisting: body.applyToExisting === true }) });
  } catch (e) {
    if (e instanceof CategoryError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Could not create the rule." }, { status: 500 });
  }
}
