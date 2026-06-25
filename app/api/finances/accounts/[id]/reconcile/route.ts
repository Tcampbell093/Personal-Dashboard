/* /api/finances/accounts/[id]/reconcile — Finance 1A.3B: reconcile a manual
 * account to the real bank balance. Atomically sets the actual balance, stamps
 * lastReconciledAt, and (when the delta ≠ 0) appends one reconcile_adjustment
 * movement. Manual accounts only; a stale/concurrent balance → 409. */

import { NextResponse } from "next/server";
import { reconcileAccount, FinanceError } from "@/lib/services/finances";
import { CURRENT_USER_ID } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function POST(request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json({ error: "Invalid account id." }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }

  const real = Number(body.realBalance);
  if (!Number.isFinite(real)) {
    return NextResponse.json({ error: "Enter a valid real balance." }, { status: 400 });
  }
  const note = typeof body.note === "string" ? body.note : null;

  try {
    const row = await reconcileAccount(CURRENT_USER_ID, id, real, note);
    if (!row) {
      return NextResponse.json(
        { error: "The balance changed since you opened reconcile — reopen and try again." },
        { status: 409 },
      );
    }
    return NextResponse.json({ account: row });
  } catch (err) {
    if (err instanceof FinanceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: "Could not reconcile the account.", detail: String(err) },
      { status: 500 },
    );
  }
}
