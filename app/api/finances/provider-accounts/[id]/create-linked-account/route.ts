/* POST /api/finances/provider-accounts/[id]/create-linked-account — Finance 1B.2.
 * Create a NEW linked Xanther account from an unmapped provider account. Accepts
 * only bounded owner choices (name, purpose, includeInSpendable); the owner,
 * provider ids, balance, and balance source are NEVER trusted from the body. It
 * never maps onto an existing manual account. */

import { NextResponse } from "next/server";
import { createLinkedAccount } from "@/lib/services/provider-accounts";
import { ConnectionError } from "@/lib/services/connections";
import { CURRENT_USER_ID } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Ctx) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid provider-account id." }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name : "";
  const purpose = typeof b.purpose === "string" ? b.purpose : "other";
  const includeInSpendable = Boolean(b.includeInSpendable);

  try {
    const result = await createLinkedAccount(CURRENT_USER_ID, id, { name, purpose, includeInSpendable });
    return NextResponse.json({ ok: true, financialAccountId: result.financialAccountId });
  } catch (e) {
    if (e instanceof ConnectionError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Could not create the linked account." }, { status: 500 });
  }
}
