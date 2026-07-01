/* POST /api/finances/categories/assignments/[transactionId]/confirm — 1B.5A.
 * Confirm a suggestion or assign a chosen category. Optional explicit rule
 * creation (suggest|auto) + apply-to-existing. Ownership + transaction state are
 * SERVER-derived; categorization mutates no finance record. */

import { NextResponse } from "next/server";
import { confirmCategoryAssignment, CategoryError } from "@/lib/services/categories";
import { CURRENT_USER_ID } from "@/lib/auth";

type Ctx = { params: Promise<{ transactionId: string }> };

export async function POST(request: Request, { params }: Ctx) {
  const transactionId = Number((await params).transactionId);
  if (!Number.isInteger(transactionId) || transactionId <= 0) return NextResponse.json({ error: "Invalid transaction id." }, { status: 400 });
  let body: { categoryId?: unknown; createRule?: unknown; ruleBehavior?: unknown; applyToExisting?: unknown } = {};
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid body." }, { status: 400 }); }
  const categoryId = Number(body.categoryId);
  if (!Number.isInteger(categoryId) || categoryId <= 0) return NextResponse.json({ error: "A category is required." }, { status: 400 });
  const opts = body.createRule === true
    ? { createRule: { behavior: body.ruleBehavior === "auto" ? "auto" as const : "suggest" as const, applyToExisting: body.applyToExisting === true } }
    : undefined;
  try {
    return NextResponse.json({ result: await confirmCategoryAssignment(CURRENT_USER_ID, transactionId, categoryId, opts) });
  } catch (e) {
    if (e instanceof CategoryError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Could not confirm the category." }, { status: 500 });
  }
}
