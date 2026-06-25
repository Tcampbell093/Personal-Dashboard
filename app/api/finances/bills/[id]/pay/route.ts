/* /api/finances/bills/[id]/pay — Finance 1A.3A: record a bill payment.
 *
 * Paying from a MANUAL account atomically marks the bill paid, deducts the
 * confirmed actual amount, and appends one negative ledger movement. Paying
 * "external"/cash (no account) marks it paid and changes no balance. A duplicate
 * or concurrent call finds the bill already paid and deducts nothing (409). */

import { NextResponse } from "next/server";
import { payBill, getBill, accountExists } from "@/lib/services/finances";
import { CURRENT_USER_ID } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function readAccountId(v: unknown): number | null | Error {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) return new Error("Invalid account id.");
  return n;
}
function readAmount(v: unknown): number | undefined | Error {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return new Error("Amount must be a non-negative number.");
  return n;
}

export async function POST(request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json({ error: "Invalid bill id." }, { status: 400 });
  }

  let body: unknown = {};
  try {
    const text = await request.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  // External/cash payment touches no account; otherwise resolve the paid-from id.
  const external = b.external === true;
  let paidAccountId: number | null = null;
  if (!external) {
    const parsed = readAccountId(b.paidAccountId);
    if (parsed instanceof Error) {
      return NextResponse.json({ error: parsed.message }, { status: 400 });
    }
    paidAccountId = parsed;
    if (paidAccountId !== null && !(await accountExists(CURRENT_USER_ID, paidAccountId))) {
      return NextResponse.json({ error: "Payment account not found." }, { status: 400 });
    }
  }

  const actual = readAmount(b.actualAmount);
  if (actual instanceof Error) {
    return NextResponse.json({ error: actual.message }, { status: 400 });
  }

  try {
    const row = await payBill(CURRENT_USER_ID, id, paidAccountId, actual);
    if (!row) {
      // Distinguish "not found" from "already paid" (duplicate/concurrent pay).
      const exists = await getBill(CURRENT_USER_ID, id);
      return exists
        ? NextResponse.json({ error: "Bill is already paid." }, { status: 409 })
        : NextResponse.json({ error: "Bill not found." }, { status: 404 });
    }
    return NextResponse.json({ bill: row });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not record the payment.", detail: String(err) },
      { status: 500 },
    );
  }
}
