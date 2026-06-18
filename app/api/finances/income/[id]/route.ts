/* /api/finances/income/[id] — update + soft-delete an income entry. */

import { NextResponse } from "next/server";
import { updateIncome, deleteIncome, type NewIncome } from "@/lib/services/finances";
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
    return NextResponse.json({ error: "Invalid income id." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  const patch: Partial<NewIncome> = {};

  if (typeof b.source === "string") {
    const source = b.source.trim();
    if (!source) {
      return NextResponse.json({ error: "Source cannot be empty." }, { status: 400 });
    }
    patch.source = source;
  }
  if (b.expectedAmount !== undefined) {
    const amount = Number(b.expectedAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      return NextResponse.json({ error: "Invalid amount." }, { status: 400 });
    }
    patch.expectedAmount = String(amount);
  }
  if ("payDate" in b) {
    if (!isDate(b.payDate)) {
      return NextResponse.json({ error: "Invalid pay date." }, { status: 400 });
    }
    patch.payDate = b.payDate;
  }
  if (b.isPayday !== undefined) patch.isPayday = Boolean(b.isPayday);

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  try {
    const row = await updateIncome(CURRENT_USER_ID, id, patch);
    if (!row) {
      return NextResponse.json({ error: "Income not found." }, { status: 404 });
    }
    return NextResponse.json({ income: row });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not update income.", detail: String(err) },
      { status: 500 },
    );
  }
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json({ error: "Invalid income id." }, { status: 400 });
  }
  try {
    const row = await deleteIncome(CURRENT_USER_ID, id);
    if (!row) {
      return NextResponse.json({ error: "Income not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not delete income.", detail: String(err) },
      { status: 500 },
    );
  }
}
