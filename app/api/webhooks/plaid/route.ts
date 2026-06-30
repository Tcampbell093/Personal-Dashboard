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
import { intakeWebhook, triggerBackgroundProcessor } from "@/lib/services/webhooks";
import { readPlaidSandboxConfig } from "@/lib/providers/plaid/env";

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

  // 5. Trigger the DURABLE background processor and OBSERVE the result. The internal
  // processor secret is sent SERVER-TO-SERVER ONLY (never returned to Plaid/browser),
  // and a login redirect is NOT silently followed. Only the documented Netlify
  // Background Function acceptance (202) counts as a successful dispatch — a redirect/
  // HTML-fallback/401/404/5xx/network error is recorded as a bounded operational
  // failure (no secret, no internal URL). Either way the durable event remains at
  // `received` and the ENABLED scheduled drainer + stale-claim recovery will process
  // it; we never mark it processed here. We do NOT run the sync inline.
  if (intake.supported && intake.isNew) {
    const base = process.env.URL || new URL(request.url).origin;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 2500); // bound the trigger; never block the ack
    const outcome = await triggerBackgroundProcessor(base, ac.signal);
    clearTimeout(t);
    if (!outcome.ok) {
      // Bounded, non-secret, non-URL diagnostic. The event stays recoverable.
      console.warn(`[webhook] worker dispatch not accepted (reason=${outcome.reason}, status=${outcome.status ?? "n/a"}); event ${intake.eventId} left for scheduled drainer.`);
    }
  }

  // 6. Prompt acknowledgement: the notification was safely received (NOT "synced").
  return NextResponse.json({ ok: true });
}
