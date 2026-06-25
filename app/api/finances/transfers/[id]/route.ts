/* /api/finances/transfers/[id] — soft-delete a (non-completed) transfer. */

import { NextResponse } from "next/server";
import { deleteTransfer } from "@/lib/services/transfers";
import { FinanceError } from "@/lib/services/finances";
import { CURRENT_USER_ID } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json({ error: "Invalid transfer id." }, { status: 400 });
  }
  try {
    const row = await deleteTransfer(CURRENT_USER_ID, id);
    if (!row) {
      return NextResponse.json({ error: "Transfer not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof FinanceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: "Could not delete the transfer.", detail: String(err) },
      { status: 500 },
    );
  }
}
