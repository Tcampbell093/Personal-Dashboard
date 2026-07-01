/* /api/finances/credit/inquiries — Finance 1C.0A. Owner-entered inquiries.
 *   GET → all inquiries.  POST → add one (identical duplicate prevented; only
 *   hard inquiries influence guidance). */

import { NextResponse } from "next/server";
import { listInquiries, createInquiry, CreditError } from "@/lib/services/credit";
import { CURRENT_USER_ID } from "@/lib/auth";

export async function GET() {
  try { return NextResponse.json({ inquiries: await listInquiries(CURRENT_USER_ID) }); }
  catch { return NextResponse.json({ error: "Could not load inquiries." }, { status: 500 }); }
}

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid body." }, { status: 400 }); }
  try { return NextResponse.json({ inquiry: await createInquiry(CURRENT_USER_ID, body as never) }); }
  catch (e) {
    if (e instanceof CreditError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Could not create the inquiry." }, { status: 500 });
  }
}
