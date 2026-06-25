/* /api/finances/transfers/[id]/reverse — Finance 1A.2: reverse a completed
 * transfer. Restores both balances and appends equal-and-opposite reversal
 * movements (originals preserved). Duplicate/concurrent reversal → 409. */

import { NextResponse } from "next/server";
import { reverseTransfer, getTransfer } from "@/lib/services/transfers";
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
    const row = await reverseTransfer(CURRENT_USER_ID, id);
    if (!row) {
      const exists = await getTransfer(CURRENT_USER_ID, id);
      return exists
        ? NextResponse.json({ error: "Transfer is not completed." }, { status: 409 })
        : NextResponse.json({ error: "Transfer not found." }, { status: 404 });
    }
    return NextResponse.json({ transfer: row });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not reverse the transfer.", detail: String(err) },
      { status: 500 },
    );
  }
}
