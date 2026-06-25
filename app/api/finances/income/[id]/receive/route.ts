/* /api/finances/income/[id]/receive — Finance 1A.2: receive a scheduled income.
 *
 * Resolves the destination (single account or split) against the confirmed gross
 * and atomically marks it received, crediting each MANUAL destination + writing
 * one positive income_received movement per destination. A duplicate/concurrent
 * receipt finds it already received and changes nothing (409). */

import { NextResponse } from "next/server";
import { receiveIncome, getIncome, FinanceError } from "@/lib/services/finances";
import { CURRENT_USER_ID } from "@/lib/auth";

const isDate = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

type Ctx = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function POST(request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json({ error: "Invalid income id." }, { status: 400 });
  }

  let body: Record<string, unknown> = {};
  try {
    const text = await request.text();
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }

  let actualAmount: number | undefined;
  if (body.actualAmount !== undefined && body.actualAmount !== null && body.actualAmount !== "") {
    const n = Number(body.actualAmount);
    if (!Number.isFinite(n) || n <= 0) {
      return NextResponse.json({ error: "Received amount must be positive." }, { status: 400 });
    }
    actualAmount = n;
  }
  let receivedDate: string | undefined;
  if (body.receivedDate !== undefined && body.receivedDate !== null && body.receivedDate !== "") {
    if (!isDate(body.receivedDate)) {
      return NextResponse.json({ error: "Invalid received date." }, { status: 400 });
    }
    receivedDate = body.receivedDate as string;
  }

  try {
    const row = await receiveIncome(CURRENT_USER_ID, id, actualAmount, receivedDate);
    if (!row) {
      const exists = await getIncome(CURRENT_USER_ID, id);
      return exists
        ? NextResponse.json({ error: "Income is already received." }, { status: 409 })
        : NextResponse.json({ error: "Income not found." }, { status: 404 });
    }
    return NextResponse.json({ income: row });
  } catch (err) {
    if (err instanceof FinanceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: "Could not receive the income.", detail: String(err) },
      { status: 500 },
    );
  }
}
