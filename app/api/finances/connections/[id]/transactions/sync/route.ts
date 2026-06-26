/* POST /api/finances/connections/[id]/transactions/sync — Finance 1B.3A.
 * Manual, owner-only, Sandbox-only incremental transaction sync. Decrypts the
 * access token server-side, runs a bounded cursor-safe sync, and returns only
 * nonsecret counts. Never accepts userId, cursor, provider ids, or a token from
 * the browser; never returns a token or encryption field. No webhook here. */

import { NextResponse } from "next/server";
import { syncConnectionTransactions } from "@/lib/services/transactions";
import { ConnectionError } from "@/lib/services/connections";
import { CURRENT_USER_ID } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Ctx) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid connection id." }, { status: 400 });
  }
  try {
    const result = await syncConnectionTransactions(CURRENT_USER_ID, id);
    // Nonsecret counts only.
    return NextResponse.json({
      added: result.added,
      modified: result.modified,
      removed: result.removed,
      skipped: result.skippedUnknownRemoval,
      pages: result.pages,
    });
  } catch (e) {
    if (e instanceof ConnectionError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Could not sync transactions." }, { status: 502 });
  }
}
