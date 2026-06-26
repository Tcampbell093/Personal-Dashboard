/* POST /api/finances/connections/[id]/accounts/sync — Finance 1B.2.
 * Owner-scoped, Sandbox-only: decrypt the access token server-side, fetch cached
 * accounts + balances, upsert provider-account rows, and return nonsecret views.
 * Exposes no access token or encrypted field. */

import { NextResponse } from "next/server";
import { syncProviderAccounts } from "@/lib/services/provider-accounts";
import { ConnectionError } from "@/lib/services/connections";
import { CURRENT_USER_ID } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Ctx) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid connection id." }, { status: 400 });
  }
  try {
    const accounts = await syncProviderAccounts(CURRENT_USER_ID, id);
    return NextResponse.json({ accounts });
  } catch (e) {
    if (e instanceof ConnectionError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Could not sync accounts." }, { status: 502 });
  }
}
