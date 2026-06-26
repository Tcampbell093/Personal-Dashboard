/* POST /api/finances/connections/exchange — Finance 1B.1.
 * Accept the browser's temporary Plaid public token, exchange it server-side,
 * encrypt the resulting access token, and store one bounded connection row.
 * Returns ONLY a nonsecret connection view — never the access token or any
 * encrypted field. The owner is resolved server-side; a browser-supplied user id
 * is ignored. Duplicate/retry exchanges return the existing connection. */

import { NextResponse } from "next/server";
import { exchangeAndStore, ConnectionError } from "@/lib/services/connections";
import { PlaidConfigError } from "@/lib/providers/plaid/env";
import { CURRENT_USER_ID } from "@/lib/auth";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  const publicToken = typeof b.publicToken === "string" ? b.publicToken : "";
  if (!publicToken) {
    return NextResponse.json({ error: "A public token is required." }, { status: 400 });
  }

  try {
    // userId is the server-resolved owner — NEVER taken from the request body.
    const connection = await exchangeAndStore(CURRENT_USER_ID, publicToken);
    return NextResponse.json({ connection });
  } catch (e) {
    if (e instanceof PlaidConfigError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 503 });
    }
    if (e instanceof ConnectionError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json({ error: "Could not complete the bank connection." }, { status: 502 });
  }
}
