/* =============================================================================
 * drain-plaid-webhooks — scheduled Netlify Function (Finance 1B.3B)
 *
 * ACTIVE RECOVERY BACKSTOP. The PRIMARY processor is the Netlify Background
 * Function (process-plaid-webhooks-background), triggered by the webhook route.
 * This low-frequency scheduled drain catches any verified event the background
 * invocation missed (trigger failed, crashed, timed out, or left a stale
 * `processing` claim) — it calls the SAME idempotent service with ATOMIC claims,
 * so it can never double-process an event a background worker is handling.
 *
 * Bounded per run (a small batch) to respect the scheduled-function timeout;
 * remaining events are picked up on the next run. The schedule is set in
 * netlify.toml. Invoke manually:  netlify functions:invoke drain-plaid-webhooks
 * ========================================================================== */

import type { Config } from "@netlify/functions";

export default async function handler() {
  try {
    const { processPendingWebhookEvents } = await import("../../lib/services/webhooks.ts");
    // Small bounded batch — stays within the scheduled-function timeout; the rest
    // wait for the next run (or the background processor).
    const result = await processPendingWebhookEvents(5);
    return new Response(JSON.stringify({ ok: true, ...result }), { status: 200, headers: { "content-type": "application/json" } });
  } catch {
    // Bounded, non-leaking — never includes financial detail or secrets.
    return new Response(JSON.stringify({ ok: false }), { status: 500, headers: { "content-type": "application/json" } });
  }
}

// Active recovery schedule: every 10 minutes.
export const config: Config = { schedule: "*/10 * * * *" };
