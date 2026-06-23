/* /api/finances/accounts/[id] — update + soft-delete an account. */

import { NextResponse } from "next/server";
import {
  updateAccount,
  deleteAccount,
  getAccount,
  ACCOUNT_TYPES,
  ACCOUNT_PURPOSES,
  BALANCE_SOURCES,
  type NewAccount,
} from "@/lib/services/finances";
import { CURRENT_USER_ID } from "@/lib/auth";

const inList = <T extends readonly string[]>(v: unknown, list: T): v is T[number] =>
  typeof v === "string" && (list as readonly string[]).includes(v);

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
  if (b.type !== undefined) {
    if (!inList(b.type, ACCOUNT_TYPES)) {
      return NextResponse.json(
        { error: `Account type must be one of: ${ACCOUNT_TYPES.join(", ")}.` },
        { status: 400 },
      );
    }
    patch.type = b.type;
  }
  if (b.purpose !== undefined) {
    if (!inList(b.purpose, ACCOUNT_PURPOSES)) {
      return NextResponse.json(
        { error: `Account purpose must be one of: ${ACCOUNT_PURPOSES.join(", ")}.` },
        { status: 400 },
      );
    }
    patch.purpose = b.purpose;
  }
  if (b.balanceSource !== undefined) {
    if (!inList(b.balanceSource, BALANCE_SOURCES)) {
      return NextResponse.json({ error: "Invalid balance source." }, { status: 400 });
    }
    patch.balanceSource = b.balanceSource;
  }
  if ("institution" in b) {
    patch.institution =
      typeof b.institution === "string" && b.institution.trim()
        ? b.institution.trim()
        : null;
  }
  if (b.includeInSpendable !== undefined) {
    patch.includeInSpendable = Boolean(b.includeInSpendable);
  }
  if (b.active !== undefined) {
    patch.active = Boolean(b.active);
  }
  if (b.currentBalance !== undefined) {
    const balance = Number(b.currentBalance);
    if (!Number.isFinite(balance)) {
      return NextResponse.json({ error: "Balance must be a number." }, { status: 400 });
    }
    patch.currentBalance = String(balance);
    patch.balanceUpdatedAt = new Date();
  }
  if ("notes" in b) {
    patch.notes =
      typeof b.notes === "string" && b.notes.trim() ? b.notes.trim() : null;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  // Data invariant: a credit account is a liability and is NEVER spendable cash.
  // Enforce it server-side on every update — whenever the RESULTING stored type
  // is credit, persist includeInSpendable=false (overriding any client attempt to
  // set it true). Changing a credit account to a non-credit type does NOT auto-
  // enable spendable — the existing value is preserved unless the owner explicitly
  // sets it in this same request. This guarantees no stored credit account ever
  // has includeInSpendable=true, independent of the UI.
  const existing = await getAccount(CURRENT_USER_ID, id);
  if (!existing) {
    return NextResponse.json({ error: "Account not found." }, { status: 404 });
  }
  const finalType = patch.type ?? existing.type ?? "checking";
  if (finalType === "credit") {
    patch.includeInSpendable = false;
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
