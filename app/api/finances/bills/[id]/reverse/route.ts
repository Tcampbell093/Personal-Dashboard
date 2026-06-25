/* /api/finances/bills/[id]/reverse — Finance 1A.3A: undo a bill payment.
 *
 * Reopens the bill (scheduled/due/overdue by its date) and, when the payment had
 * deducted a manual account, atomically credits the account back and appends one
 * positive reversal movement pointing at the original payment (which is never
 * deleted). A duplicate or concurrent reversal cannot credit twice (409). A bill
 * paid externally or before the ledger existed simply reopens (no credit). */

import { NextResponse } from "next/server";
import { reverseBillPayment, getBill } from "@/lib/services/finances";
import { CURRENT_USER_ID } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function POST(_request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json({ error: "Invalid bill id." }, { status: 400 });
  }
  try {
    const row = await reverseBillPayment(CURRENT_USER_ID, id);
    if (!row) {
      const exists = await getBill(CURRENT_USER_ID, id);
      return exists
        ? NextResponse.json({ error: "Bill is not paid." }, { status: 409 })
        : NextResponse.json({ error: "Bill not found." }, { status: 404 });
    }
    return NextResponse.json({ bill: row });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not reverse the payment.", detail: String(err) },
      { status: 500 },
    );
  }
}
