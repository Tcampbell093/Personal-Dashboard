/* /api/finances/categories/rules/[id] — Finance 1B.5A.
 *   PATCH  → change category target, behavior (suggest|auto), priority, enable/disable.
 *   DELETE → soft-disable when the rule has assignment history; else remove. */

import { NextResponse } from "next/server";
import { updateRule, deleteRule, applyRuleToExisting, CategoryError } from "@/lib/services/categories";
import { CURRENT_USER_ID } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Ctx) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid rule id." }, { status: 400 });
  let body: { categoryId?: unknown; behavior?: unknown; isActive?: unknown; priority?: unknown; applyToExisting?: unknown } = {};
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid body." }, { status: 400 }); }
  const patch: { categoryId?: number; behavior?: "suggest" | "auto"; isActive?: boolean; priority?: number } = {};
  if (typeof body.categoryId === "number") patch.categoryId = body.categoryId;
  if (body.behavior === "suggest" || body.behavior === "auto") patch.behavior = body.behavior;
  if (typeof body.isActive === "boolean") patch.isActive = body.isActive;
  if (typeof body.priority === "number") patch.priority = body.priority;
  try {
    await updateRule(CURRENT_USER_ID, id, patch);
    const applied = body.applyToExisting === true ? await applyRuleToExisting(CURRENT_USER_ID, id) : 0;
    return NextResponse.json({ ok: true, appliedToExisting: applied });
  } catch (e) {
    if (e instanceof CategoryError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Could not update the rule." }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid rule id." }, { status: 400 });
  try {
    return NextResponse.json({ result: await deleteRule(CURRENT_USER_ID, id) });
  } catch (e) {
    if (e instanceof CategoryError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Could not delete the rule." }, { status: 500 });
  }
}
