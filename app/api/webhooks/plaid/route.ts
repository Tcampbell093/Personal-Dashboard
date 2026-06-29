/* POST /api/webhooks/plaid — Finance 1B.3B (reliability correction).
 * PUBLIC + unauthenticated (Plaid calls it, not the owner) — trust comes ONLY
 * from cryptographic verification, never the login session. The route:
 *   1. reads the EXACT raw body (before any JSON reformatting);
 *   2. verifies the Plaid-Verification JWT signature + raw-body hash + iat;
 *   3. only THEN parses the bounded supported event;
 *   4. durably records the event (idempotent);
 *   5. TRIGGERS the durable Netlify Background Function processor (fire-and-await
 *      the quick 202 trigger — NOT the full sync);
 *   6. returns a prompt, nonsecret acknowledgement (Plaid's 10s window) that means
 *      ONLY "the verified notification was safely received".
 * It NEVER runs the full transaction sync inline, never returns secrets, and never
 * trusts a body-supplied user id. If the trigger fails, the durable event remains
 * recoverable by the scheduled drainer backstop + stale-claim recovery. */

import { NextResponse } from "next/server";
import { plaidAdapter } from "@/lib/providers/plaid/adapter";
import { intakeWebhook, PROCESSOR_HEADER } from "@/lib/services/webhooks";
import { readPlaidSandboxConfig } from "@/lib/providers/plaid/env";

const BACKGROUND_FN = "/.netlify/functions/process-plaid-webhooks-background";

export async function POST(request: Request) {
  // 1. Exact raw bytes (NOT request.json() — the body hash is whitespace-sensitive).
  const rawBody = await request.text();
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => { headers[k] = v; });

  // 2-3. Verify BEFORE trusting or parsing. Any failure → bounded, non-leaking 400.
  let verified;
  try {
    verified = await plaidAdapter.verifyWebhook({ headers, rawBody });
  } catch {
    return NextResponse.json({ error: "Webhook verification failed." }, { status: 400 });
  }

  // Sandbox-only (the verifier already pins to the Sandbox key set).
  let environment: string;
  try { environment = readPlaidSandboxConfig().env; } catch { return NextResponse.json({ error: "Not configured." }, { status: 503 }); }

  // 4. Durable, idempotent intake. If storage fails, return 500 so Plaid retries
  // (nothing is durable yet — never ack a notification we couldn't record).
  let intake;
  try {
    intake = await intakeWebhook(verified, environment);
  } catch {
    return NextResponse.json({ error: "Could not record the webhook." }, { status: 500 });
  }

  // 5. Trigger the DURABLE background processor (it ack's 202 quickly and runs the
  // sync asynchronously with retries). We do NOT run the sync inline. The internal
  // processor secret is sent SERVER-TO-SERVER ONLY (never returned to Plaid/browser).
  // A trigger failure — including a missing secret — is harmless: the event is durable
  // and the ENABLED scheduled drainer + stale-claim recovery will process it.
  if (intake.supported && intake.isNew) {
    try {
      const base = process.env.URL || new URL(request.url).origin;
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 2500); // bound the trigger; never block the ack
      await fetch(`${base}${BACKGROUND_FN}`, {
        method: "POST",
        headers: { [PROCESSOR_HEADER]: process.env.PLAID_WEBHOOK_PROCESSOR_SECRET ?? "" },
        signal: ac.signal,
      }).catch(() => {});
      clearTimeout(t);
    } catch { /* event durable → recovered by the backstop */ }
  }

  // 6. Prompt acknowledgement: the notification was safely received (NOT "synced").
  return NextResponse.json({ ok: true });
}
