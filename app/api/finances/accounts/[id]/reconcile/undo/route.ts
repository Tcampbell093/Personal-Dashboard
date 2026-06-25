/* /api/finances/accounts/[id]/reconcile/undo — Finance 1A.3B: undo the latest
 * unreversed reconciliation. Restores the prior balance + prior reconcile
 * timestamp and appends a reconcile_reversal movement (original preserved).
 * Only while it is the latest reconcile and the balance is unchanged → else 409. */

import { NextResponse } from "next/server";
import { reverseReconciliation, FinanceError } from "@/lib/services/finances";
import { CURRENT_USER_ID } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function POST(_request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json({ error: "Invalid account id." }, { status: 400 });
  }
  try {
    const row = await reverseReconciliation(CURRENT_USER_ID, id);
    if (!row) {
      return NextResponse.json(
        { error: "No reversible reconciliation (already undone, or the balance changed since)." },
        { status: 409 },
      );
    }
    return NextResponse.json({ account: row });
  } catch (err) {
    if (err instanceof FinanceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: "Could not undo the reconciliation.", detail: String(err) },
      { status: 500 },
    );
  }
}
