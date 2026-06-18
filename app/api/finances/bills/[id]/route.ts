/* /api/finances/bills/[id] — update, mark paid (status=paid), soft-delete. */

import { NextResponse } from "next/server";
import {
  updateBill,
  deleteBill,
  BILL_STATUSES,
  type NewBill,
} from "@/lib/services/finances";
import { CURRENT_USER_ID } from "@/lib/auth";

const isDate = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

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
  if (b.status !== undefined) {
    if (!BILL_STATUSES.includes(b.status as never)) {
      return NextResponse.json({ error: "Invalid status." }, { status: 400 });
    }
    patch.status = b.status as (typeof BILL_STATUSES)[number];
    if (b.status === "paid") patch.paidAt = new Date();
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
