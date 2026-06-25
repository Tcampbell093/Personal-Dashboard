/* /api/finances/transfers — list + create transfers between owned accounts. */

import { NextResponse } from "next/server";
import { createTransfer, listTransfers, toTransferViews } from "@/lib/services/transfers";
import { FinanceError } from "@/lib/services/finances";
import { CURRENT_USER_ID } from "@/lib/auth";

const isDate = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

export async function GET() {
  try {
    return NextResponse.json({
      transfers: toTransferViews(await listTransfers(CURRENT_USER_ID)),
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not load transfers.", detail: String(err) },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  const fromAccountId = Number(b.fromAccountId);
  const toAccountId = Number(b.toAccountId);
  if (!Number.isInteger(fromAccountId) || !Number.isInteger(toAccountId)) {
    return NextResponse.json({ error: "Source and destination accounts are required." }, { status: 400 });
  }
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: "A positive amount is required." }, { status: 400 });
  }
  if (b.scheduledDate !== undefined && b.scheduledDate !== null && b.scheduledDate !== "" && !isDate(b.scheduledDate)) {
    return NextResponse.json({ error: "Invalid scheduled date." }, { status: 400 });
  }
  const note = typeof b.note === "string" && b.note.trim() ? b.note.trim() : null;

  try {
    const row = await createTransfer(CURRENT_USER_ID, {
      fromAccountId,
      toAccountId,
      amount,
      scheduledDate: isDate(b.scheduledDate) ? b.scheduledDate : null,
      note,
    });
    return NextResponse.json({ transfer: row }, { status: 201 });
  } catch (err) {
    if (err instanceof FinanceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: "Could not create the transfer.", detail: String(err) },
      { status: 500 },
    );
  }
}
