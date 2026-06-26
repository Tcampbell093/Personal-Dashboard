/* GET /api/finances/transactions — Finance 1B.3A.
 * Owner-scoped, nonsecret imported-transaction views with bounded filters
 * (account, pending/posted, active/removed, limit). Returns no token, encryption
 * field, provider transaction id, or full account number. Read-only evidence. */

import { NextResponse } from "next/server";
import { listImportedTransactions, type TransactionFilters } from "@/lib/services/transactions";
import { CURRENT_USER_ID } from "@/lib/auth";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const filters: TransactionFilters = {};

  const acct = url.searchParams.get("account");
  if (acct === "none") filters.financialAccountId = null;
  else if (acct && /^\d+$/.test(acct)) filters.financialAccountId = Number(acct);

  const pending = url.searchParams.get("pending");
  if (pending === "true") filters.isPending = true;
  else if (pending === "false") filters.isPending = false;

  const status = url.searchParams.get("status");
  if (status === "active" || status === "removed" || status === "all") filters.status = status;

  const limit = url.searchParams.get("limit");
  if (limit && /^\d+$/.test(limit)) filters.limit = Number(limit);

  try {
    return NextResponse.json({ transactions: await listImportedTransactions(CURRENT_USER_ID, filters) });
  } catch {
    return NextResponse.json({ error: "Could not load transactions." }, { status: 500 });
  }
}
