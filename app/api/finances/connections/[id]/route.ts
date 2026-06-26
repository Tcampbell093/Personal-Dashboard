/* DELETE /api/finances/connections/[id] — Finance 1B.1 Sandbox cleanup
 * (Finance 1B.2 correction). Owner-scoped: revokes the Plaid Sandbox Item
 * (best-effort), deletes the connection + its UNMAPPED provider-account
 * snapshots. A connection with any LINKED Xanther account is REJECTED with 409
 * (it would orphan a linked account) — nothing is mutated. Touches no manual
 * account, movement, bill, income, or transfer. No secret in the response. */

import { NextResponse } from "next/server";
import { deleteConnection, ConnectionError } from "@/lib/services/connections";
import { CURRENT_USER_ID } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(_request: Request, { params }: Ctx) {
  const raw = (await params).id;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid connection id." }, { status: 400 });
  }
  try {
    const result = await deleteConnection(CURRENT_USER_ID, id);
    if (!result.deleted) return NextResponse.json({ error: "Connection not found." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof ConnectionError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Could not remove the connection." }, { status: 500 });
  }
}
