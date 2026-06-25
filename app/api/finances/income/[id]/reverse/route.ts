/* /api/finances/income/[id]/reverse — Finance 1A.2: undo an income receipt.
 *
 * Returns the income to scheduled and, for each manual income_received movement,
 * decreases the account back and appends one negative income_reversal movement
 * referencing the original (never deleted). A duplicate/concurrent reversal
 * cannot subtract twice (409). */

import { NextResponse } from "next/server";
import { reverseIncomeReceipt, getIncome } from "@/lib/services/finances";
import { CURRENT_USER_ID } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function POST(_request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json({ error: "Invalid income id." }, { status: 400 });
  }
  try {
    const row = await reverseIncomeReceipt(CURRENT_USER_ID, id);
    if (!row) {
      const exists = await getIncome(CURRENT_USER_ID, id);
      return exists
        ? NextResponse.json({ error: "Income is not received." }, { status: 409 })
        : NextResponse.json({ error: "Income not found." }, { status: 404 });
    }
    return NextResponse.json({ income: row });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not reverse the income receipt.", detail: String(err) },
      { status: 500 },
    );
  }
}
