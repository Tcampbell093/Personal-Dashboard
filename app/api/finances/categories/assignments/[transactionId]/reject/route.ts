/* POST /api/finances/categories/assignments/[transactionId]/reject — 1B.5A.
 * Reject the current category suggestion. Mutates no finance record; the rejected
 * row is kept so an identical suggestion isn't silently reopened. */

import { NextResponse } from "next/server";
import { rejectCategorySuggestion, CategoryError } from "@/lib/services/categories";
import { CURRENT_USER_ID } from "@/lib/auth";

type Ctx = { params: Promise<{ transactionId: string }> };

export async function POST(_request: Request, { params }: Ctx) {
  const transactionId = Number((await params).transactionId);
  if (!Number.isInteger(transactionId) || transactionId <= 0) return NextResponse.json({ error: "Invalid transaction id." }, { status: 400 });
  try {
    return NextResponse.json({ result: await rejectCategorySuggestion(CURRENT_USER_ID, transactionId) });
  } catch (e) {
    if (e instanceof CategoryError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Could not reject the suggestion." }, { status: 500 });
  }
}
