/* /api/finances/credit/collections — Finance 1C.0A. Owner-entered collections.
 *   GET → all collections.  POST → add one. Xanther never declares a debt valid. */

import { NextResponse } from "next/server";
import { listCollections, createCollection, CreditError } from "@/lib/services/credit";
import { CURRENT_USER_ID } from "@/lib/auth";

export async function GET() {
  try { return NextResponse.json({ collections: await listCollections(CURRENT_USER_ID) }); }
  catch { return NextResponse.json({ error: "Could not load collections." }, { status: 500 }); }
}

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid body." }, { status: 400 }); }
  try { return NextResponse.json({ collection: await createCollection(CURRENT_USER_ID, body as never) }); }
  catch (e) {
    if (e instanceof CreditError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Could not create the collection." }, { status: 500 });
  }
}
