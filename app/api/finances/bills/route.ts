/* /api/finances/bills — list + create bills (financialEntries, kind="bill"). */

import { NextResponse } from "next/server";
import { createBill, listBills } from "@/lib/services/finances";
import { CURRENT_USER_ID } from "@/lib/auth";

const isDate = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

export async function GET() {
  try {
    return NextResponse.json({ bills: await listBills(CURRENT_USER_ID) });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not load bills.", detail: String(err) },
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

  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "Bill name is required." }, { status: 400 });
  }
  const amount = Number(b.expectedAmount);
  if (!Number.isFinite(amount) || amount < 0) {
    return NextResponse.json(
      { error: "A non-negative amount is required." },
      { status: 400 },
    );
  }
  if (b.dueDate !== undefined && b.dueDate !== null && b.dueDate !== "" && !isDate(b.dueDate)) {
    return NextResponse.json({ error: "Invalid due date." }, { status: 400 });
  }

  try {
    const row = await createBill({
      userId: CURRENT_USER_ID,
      name,
      expectedAmount: String(amount),
      dueDate: isDate(b.dueDate) ? b.dueDate : null,
      status: "scheduled",
    });
    return NextResponse.json({ bill: row }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not create bill.", detail: String(err) },
      { status: 500 },
    );
  }
}
