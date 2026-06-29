/* =============================================================================
 * process-plaid-webhooks-background — Netlify BACKGROUND Function (Finance 1B.3B)
 *
 * The `-background` suffix makes this a Netlify Background Function: it returns
 * 202 immediately, runs asynchronously for up to ~15 minutes, and Netlify retries
 * it automatically on failure. This is the ACTIVE durable processor for verified
 * webhook events — the webhook route triggers it AFTER durably storing the event,
 * so the route never waits for the full transaction sync (respecting Plaid's 10s
 * window).
 *
 * It claims pending/failed/stale-`processing` events ATOMICALLY (so overlapping
 * invocations / the scheduled drainer can't double-process), then runs the
 * EXISTING transaction-sync service (fetch→buffer→atomic, cursor-safe). A verified
 * event is never lost: it stays recoverable until it is durably processed/ignored
 * or truthfully reaches bounded retry exhaustion.
 *
 * ACCESS CONTROL: the endpoint is publicly reachable, so it requires a server-only
 * internal credential (PLAID_WEBHOOK_PROCESSOR_SECRET) in a bounded header, compared
 * in constant time, BEFORE any database query, claim, or Plaid call. Missing/incorrect
 * credentials are rejected with a generic 401 and do no work; a missing server-side
 * secret fails closed. The credential is never logged or returned. The webhook route
 * supplies it server-to-server. Authorized manual invoke for testing:
 *   netlify functions:invoke process-plaid-webhooks-background \
 *     --header "X-Xanther-Webhook-Processor-Key: $PLAID_WEBHOOK_PROCESSOR_SECRET"
 * ========================================================================== */

const UNAUTHORIZED = () => new Response(JSON.stringify({ ok: false }), { status: 401, headers: { "content-type": "application/json" } });

export default async function handler(req: Request) {
  // Importing the service module does NOT query the DB — so we can authorize
  // BEFORE any DB/Plaid work happens.
  const { authorizeProcessorRequest, processPendingWebhookEvents, PROCESSOR_HEADER } = await import("../../lib/services/webhooks.ts");

  // Authorize first — generic 401 with NO work on missing/incorrect/unconfigured.
  if (!authorizeProcessorRequest(req.headers.get(PROCESSOR_HEADER))) return UNAUTHORIZED();

  try {
    const result = await processPendingWebhookEvents(25);
    return new Response(JSON.stringify({ ok: true, ...result }), { status: 202, headers: { "content-type": "application/json" } });
  } catch {
    // Bounded, non-leaking. A 5xx makes Netlify retry the background function.
    return new Response(JSON.stringify({ ok: false }), { status: 500, headers: { "content-type": "application/json" } });
  }
}
