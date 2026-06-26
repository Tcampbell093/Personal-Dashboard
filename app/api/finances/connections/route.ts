/* /api/finances/connections — Finance 1B.1.
 * GET: list the owner's nonsecret bank-connection views (no encrypted-token
 * fields, no provider secrets). The owner is authenticated by the app's password
 * gate (middleware) and resolved server-side; a browser-supplied user id is never
 * trusted. */

import { NextResponse } from "next/server";
import { listConnections } from "@/lib/services/connections";
import { CURRENT_USER_ID } from "@/lib/auth";

export async function GET() {
  try {
    return NextResponse.json({ connections: await listConnections(CURRENT_USER_ID) });
  } catch {
    // Never include error detail that could reference a secret.
    return NextResponse.json({ error: "Could not load connections." }, { status: 500 });
  }
}
