/* PATCH/DELETE /api/finances/credit/scores/[id] — Finance 1C.0A.
 * Correction-safe update; DELETE is a soft delete (history remains auditable). */

import { NextResponse } from "next/server";
import { updateScore, deleteScore, CreditError } from "@/lib/services/credit";
import { CURRENT_USER_ID } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Ctx) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid body." }, { status: 400 }); }
  try { return NextResponse.json({ score: await updateScore(CURRENT_USER_ID, id, body as never) }); }
  catch (e) {
    if (e instanceof CreditError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Could not update the score snapshot." }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  try { return NextResponse.json(await deleteScore(CURRENT_USER_ID, id)); }
  catch (e) {
    if (e instanceof CreditError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Could not delete the score snapshot." }, { status: 500 });
  }
}
