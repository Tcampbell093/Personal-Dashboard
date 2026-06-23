/* /api/finances/accounts — list + create financial accounts.
 *
 * Finance 1A.1: accounts carry institution, a validated type + purpose, a
 * manually entered actual balance, balanceSource (always "manual" today),
 * an include-in-spendable flag, and an active flag. Type/purpose/balanceSource
 * are validated against the controlled vocabularies in the service layer. */

import { NextResponse } from "next/server";
import {
  createAccount,
  listAccounts,
  ACCOUNT_TYPES,
  ACCOUNT_PURPOSES,
  BALANCE_SOURCES,
} from "@/lib/services/finances";
import { CURRENT_USER_ID } from "@/lib/auth";

const inList = <T extends readonly string[]>(v: unknown, list: T): v is T[number] =>
  typeof v === "string" && (list as readonly string[]).includes(v);

export async function GET() {
  try {
    return NextResponse.json({ accounts: await listAccounts(CURRENT_USER_ID) });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not load accounts.", detail: String(err) },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "Account name is required." }, { status: 400 });
  }

  const type = b.type === undefined || b.type === "" ? "checking" : b.type;
  if (!inList(type, ACCOUNT_TYPES)) {
    return NextResponse.json(
      { error: `Account type must be one of: ${ACCOUNT_TYPES.join(", ")}.` },
      { status: 400 },
    );
  }
  const purpose = b.purpose === undefined || b.purpose === "" ? "other" : b.purpose;
  if (!inList(purpose, ACCOUNT_PURPOSES)) {
    return NextResponse.json(
      { error: `Account purpose must be one of: ${ACCOUNT_PURPOSES.join(", ")}.` },
      { status: 400 },
    );
  }
  const balanceSource =
    b.balanceSource === undefined || b.balanceSource === "" ? "manual" : b.balanceSource;
  if (!inList(balanceSource, BALANCE_SOURCES)) {
    return NextResponse.json({ error: "Invalid balance source." }, { status: 400 });
  }

  const balance = Number(b.currentBalance);
  if (b.currentBalance !== undefined && b.currentBalance !== "" && !Number.isFinite(balance)) {
    return NextResponse.json({ error: "Balance must be a number." }, { status: 400 });
  }

  // Savings/emergency default to excluded from spendable cash unless the owner
  // says otherwise; everything else defaults to included. Credit accounts are
  // liabilities and are never spendable cash, regardless of what was sent.
  const defaultSpendable = !(purpose === "savings" || purpose === "emergency");
  const includeInSpendable =
    type === "credit"
      ? false
      : b.includeInSpendable === undefined
        ? defaultSpendable
        : Boolean(b.includeInSpendable);
  const active = b.active === undefined ? true : Boolean(b.active);
  const institution =
    typeof b.institution === "string" && b.institution.trim()
      ? b.institution.trim()
      : null;
  const notes = typeof b.notes === "string" && b.notes.trim() ? b.notes.trim() : null;

  try {
    const row = await createAccount({
      userId: CURRENT_USER_ID,
      name,
      type,
      institution,
      purpose,
      currentBalance: String(Number.isFinite(balance) ? balance : 0),
      balanceSource,
      includeInSpendable,
      active,
      notes,
      balanceUpdatedAt: new Date(),
    });
    return NextResponse.json({ account: row }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not create account.", detail: String(err) },
      { status: 500 },
    );
  }
}
