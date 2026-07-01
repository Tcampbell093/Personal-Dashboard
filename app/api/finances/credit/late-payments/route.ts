/* /api/finances/credit/late-payments — Finance 1C.0A. Owner-entered late records.
 *   GET → all records.  POST → add one (must link an owned credit account). */

import { NextResponse } from "next/server";
import { listLatePayments, createLatePayment, CreditError } from "@/lib/services/credit";
import { CURRENT_USER_ID } from "@/lib/auth";

export async function GET() {
  try { return NextResponse.json({ latePayments: await listLatePayments(CURRENT_USER_ID) }); }
  catch { return NextResponse.json({ error: "Could not load late payments." }, { status: 500 }); }
}

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid body." }, { status: 400 }); }
  try { return NextResponse.json({ latePayment: await createLatePayment(CURRENT_USER_ID, body as never) }); }
  catch (e) {
    if (e instanceof CreditError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Could not create the late-payment record." }, { status: 500 });
  }
}
