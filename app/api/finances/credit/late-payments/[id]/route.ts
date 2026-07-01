/* PATCH /api/finances/credit/late-payments/[id] — Finance 1C.0A.
 * Resolving a record keeps it historical. */

import { NextResponse } from "next/server";
import { updateLatePayment, CreditError } from "@/lib/services/credit";
import { CURRENT_USER_ID } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Ctx) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid body." }, { status: 400 }); }
  try { return NextResponse.json({ latePayment: await updateLatePayment(CURRENT_USER_ID, id, body as never) }); }
  catch (e) {
    if (e instanceof CreditError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Could not update the late-payment record." }, { status: 500 });
  }
}
