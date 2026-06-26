/* GET /api/finances/connections/[id]/accounts — Finance 1B.2.
 * Owner-scoped list of discovered provider accounts (nonsecret views only — no
 * access token, no encrypted field). */

import { NextResponse } from "next/server";
import { listProviderAccounts } from "@/lib/services/provider-accounts";
import { ConnectionError } from "@/lib/services/connections";
import { CURRENT_USER_ID } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Ctx) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid connection id." }, { status: 400 });
  }
  try {
    const accounts = await listProviderAccounts(CURRENT_USER_ID, id);
    return NextResponse.json({ accounts });
  } catch (e) {
    if (e instanceof ConnectionError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Could not load accounts." }, { status: 500 });
  }
}
