/* POST /api/finances/connections/link-token — Finance 1B.1.
 * Create a short-lived Plaid (Sandbox) Link token for the browser. Returns ONLY
 * the link token + expiration — never the client id, Plaid secret, encryption
 * key, access token, or any internal field. Sandbox config is enforced server-
 * side; a non-sandbox or misconfigured environment fails closed. */

import { NextResponse } from "next/server";
import { createLinkSession, ConnectionError } from "@/lib/services/connections";
import { PlaidConfigError } from "@/lib/providers/plaid/env";
import { CURRENT_USER_ID } from "@/lib/auth";

export async function POST() {
  try {
    const session = await createLinkSession(CURRENT_USER_ID);
    // Minimal, nonsecret payload.
    return NextResponse.json({ linkToken: session.linkToken, expiresAt: session.expiresAt });
  } catch (e) {
    if (e instanceof PlaidConfigError) {
      // Non-secret: names the misconfigured variable, never a value.
      return NextResponse.json({ error: e.message, code: e.code }, { status: 503 });
    }
    if (e instanceof ConnectionError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json({ error: "Could not start a bank connection." }, { status: 502 });
  }
}
