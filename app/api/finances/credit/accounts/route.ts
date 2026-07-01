/* /api/finances/credit/accounts — Finance 1C.0A. Owner-entered credit accounts.
 *   GET → all accounts.  POST → add an account (type/limits/balances validated). */

import { NextResponse } from "next/server";
import { listAccounts, createAccount, CreditError } from "@/lib/services/credit";
import { CURRENT_USER_ID } from "@/lib/auth";

export async function GET() {
  try { return NextResponse.json({ accounts: await listAccounts(CURRENT_USER_ID) }); }
  catch { return NextResponse.json({ error: "Could not load accounts." }, { status: 500 }); }
}

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid body." }, { status: 400 }); }
  try { return NextResponse.json({ account: await createAccount(CURRENT_USER_ID, body as never) }); }
  catch (e) {
    if (e instanceof CreditError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Could not create the account." }, { status: 500 });
  }
}
