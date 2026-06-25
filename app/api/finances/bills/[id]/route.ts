/* /api/finances/bills/[id] — edit fields, mark paid, soft-delete a bill.
 *
 * Finance 1A.3A: the bill lifecycle is owned by the ledger. `status:"paid"` is
 * routed through `payBill` (atomic deduct + movement when paid from a manual
 * account; external when no account). Reopening a paid bill is NOT a field edit
 * — it must go through `POST .../reverse` so the deduction is credited back.
 * PATCH therefore only edits descriptive fields + accepts `status:"paid"`. */

import { NextResponse } from "next/server";
import {
  updateBill,
  deleteBill,
  payBill,
  getBill,
  accountExists,
  type NewBill,
} from "@/lib/services/finances";
import { CURRENT_USER_ID } from "@/lib/auth";

const isDate = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

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

type Ctx = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function PATCH(request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json({ error: "Invalid bill id." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  // --- Lifecycle: paying goes through the ledger; reopening uses /reverse. ---
  if (b.status !== undefined) {
    if (b.status !== "paid") {
      return NextResponse.json(
        {
          error:
            "Bill status is managed by the pay/reverse actions; only status='paid' is accepted here. Reopen a paid bill via POST .../reverse.",
        },
        { status: 400 },
      );
    }
    const paid = readAccountId(b.paidAccountId);
    if (paid instanceof Error) {
      return NextResponse.json({ error: paid.message }, { status: 400 });
    }
    if (paid !== null && !(await accountExists(CURRENT_USER_ID, paid))) {
      return NextResponse.json({ error: "Payment account not found." }, { status: 400 });
    }
    const actual = readAmount(b.actualAmount);
    if (actual instanceof Error) {
      return NextResponse.json({ error: actual.message }, { status: 400 });
    }
    try {
      const row = await payBill(CURRENT_USER_ID, id, paid, actual);
      if (!row) {
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

  // --- Descriptive field edits (never touch balances or the ledger). ---
  const patch: Partial<NewBill> = {};
  if (typeof b.name === "string") {
    const name = b.name.trim();
    if (!name) {
      return NextResponse.json({ error: "Name cannot be empty." }, { status: 400 });
    }
    patch.name = name;
  }
  if (b.expectedAmount !== undefined) {
    const amount = Number(b.expectedAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      return NextResponse.json({ error: "Invalid amount." }, { status: 400 });
    }
    patch.expectedAmount = String(amount);
  }
  if ("dueDate" in b) {
    if (b.dueDate && !isDate(b.dueDate)) {
      return NextResponse.json({ error: "Invalid due date." }, { status: 400 });
    }
    patch.dueDate = isDate(b.dueDate) ? b.dueDate : null;
  }
  if ("sourceAccountId" in b) {
    const src = readAccountId(b.sourceAccountId);
    if (src instanceof Error) {
      return NextResponse.json({ error: src.message }, { status: 400 });
    }
    if (src !== null && !(await accountExists(CURRENT_USER_ID, src))) {
      return NextResponse.json({ error: "Source account not found." }, { status: 400 });
    }
    patch.sourceAccountId = src;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  try {
    const row = await updateBill(CURRENT_USER_ID, id, patch);
    if (!row) {
      return NextResponse.json({ error: "Bill not found." }, { status: 404 });
    }
    return NextResponse.json({ bill: row });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not update bill.", detail: String(err) },
      { status: 500 },
    );
  }
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json({ error: "Invalid bill id." }, { status: 400 });
  }
  try {
    const row = await deleteBill(CURRENT_USER_ID, id);
    if (!row) {
      return NextResponse.json({ error: "Bill not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not delete bill.", detail: String(err) },
      { status: 500 },
    );
  }
}
