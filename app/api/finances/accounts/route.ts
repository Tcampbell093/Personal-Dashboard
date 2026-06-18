/* /api/finances/accounts — list + create financial accounts. */

import { NextResponse } from "next/server";
import { createAccount, listAccounts } from "@/lib/services/finances";
import { CURRENT_USER_ID } from "@/lib/auth";

export async function GET() {
  try {
    return NextResponse.json({ accounts: await listAccounts(CURRENT_USER_ID) });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not load accounts.", detail: String(err) },
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
    return NextResponse.json({ error: "Account name is required." }, { status: 400 });
  }
  const balance = Number(b.currentBalance);
  if (b.currentBalance !== undefined && !Number.isFinite(balance)) {
    return NextResponse.json({ error: "Balance must be a number." }, { status: 400 });
  }

  try {
    const row = await createAccount({
      userId: CURRENT_USER_ID,
      name,
      type: typeof b.type === "string" && b.type ? b.type : "checking",
      currentBalance: String(Number.isFinite(balance) ? balance : 0),
      balanceUpdatedAt: new Date(),
    });
    return NextResponse.json({ account: row }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not create account.", detail: String(err) },
      { status: 500 },
    );
  }
}
