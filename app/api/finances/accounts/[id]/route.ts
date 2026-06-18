/* /api/finances/accounts/[id] — update + soft-delete an account. */

import { NextResponse } from "next/server";
import { updateAccount, deleteAccount, type NewAccount } from "@/lib/services/finances";
import { CURRENT_USER_ID } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function PATCH(request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json({ error: "Invalid account id." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  const patch: Partial<NewAccount> = {};

  if (typeof b.name === "string") {
    const name = b.name.trim();
    if (!name) {
      return NextResponse.json({ error: "Name cannot be empty." }, { status: 400 });
    }
    patch.name = name;
  }
  if (typeof b.type === "string" && b.type) patch.type = b.type;
  if (b.currentBalance !== undefined) {
    const balance = Number(b.currentBalance);
    if (!Number.isFinite(balance)) {
      return NextResponse.json({ error: "Balance must be a number." }, { status: 400 });
    }
    patch.currentBalance = String(balance);
    patch.balanceUpdatedAt = new Date();
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  try {
    const row = await updateAccount(CURRENT_USER_ID, id, patch);
    if (!row) {
      return NextResponse.json({ error: "Account not found." }, { status: 404 });
    }
    return NextResponse.json({ account: row });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not update account.", detail: String(err) },
      { status: 500 },
    );
  }
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json({ error: "Invalid account id." }, { status: 400 });
  }
  try {
    const row = await deleteAccount(CURRENT_USER_ID, id);
    if (!row) {
      return NextResponse.json({ error: "Account not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not delete account.", detail: String(err) },
      { status: 500 },
    );
  }
}
