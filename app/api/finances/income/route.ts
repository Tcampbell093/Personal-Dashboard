/* /api/finances/income — list + create income entries (paydays). */

import { NextResponse } from "next/server";
import { createIncome, listIncome } from "@/lib/services/finances";
import { CURRENT_USER_ID } from "@/lib/auth";

const isDate = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

export async function GET() {
  try {
    return NextResponse.json({ income: await listIncome(CURRENT_USER_ID) });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not load income.", detail: String(err) },
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

  const source = typeof b.source === "string" ? b.source.trim() : "";
  if (!source) {
    return NextResponse.json({ error: "Income source is required." }, { status: 400 });
  }
  const amount = Number(b.expectedAmount);
  if (!Number.isFinite(amount) || amount < 0) {
    return NextResponse.json(
      { error: "A non-negative amount is required." },
      { status: 400 },
    );
  }
  if (!isDate(b.payDate)) {
    return NextResponse.json(
      { error: "A valid pay date (YYYY-MM-DD) is required." },
      { status: 400 },
    );
  }

  try {
    const row = await createIncome({
      userId: CURRENT_USER_ID,
      source,
      expectedAmount: String(amount),
      payDate: b.payDate,
      isPayday: b.isPayday === undefined ? true : Boolean(b.isPayday),
    });
    return NextResponse.json({ income: row }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not create income.", detail: String(err) },
      { status: 500 },
    );
  }
}
