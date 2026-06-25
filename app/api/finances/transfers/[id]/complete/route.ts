/* /api/finances/transfers/[id]/complete — Finance 1A.2: complete a transfer.
 *
 * manual→manual moves both balances + writes paired movements atomically;
 * manual→linked deducts the source only. A duplicate/concurrent completion finds
 * it already completed and does nothing (409). Linked-source is rejected. */

import { NextResponse } from "next/server";
import { completeTransfer, getTransfer } from "@/lib/services/transfers";
import { FinanceError } from "@/lib/services/finances";
import { CURRENT_USER_ID } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function POST(_request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json({ error: "Invalid transfer id." }, { status: 400 });
  }
  try {
    const row = await completeTransfer(CURRENT_USER_ID, id);
    if (!row) {
      const exists = await getTransfer(CURRENT_USER_ID, id);
      return exists
        ? NextResponse.json({ error: "Transfer is not scheduled." }, { status: 409 })
        : NextResponse.json({ error: "Transfer not found." }, { status: 404 });
    }
    return NextResponse.json({ transfer: row });
  } catch (err) {
    if (err instanceof FinanceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: "Could not complete the transfer.", detail: String(err) },
      { status: 500 },
    );
  }
}
