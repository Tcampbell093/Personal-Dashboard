/* =============================================================================
 * Xanther — Plaid webhook intake + processing (Finance 1B.3B, server-only)
 *
 * A verified webhook is just a NOTIFICATION. Intake stores a bounded, non-secret
 * durable event (idempotent by body hash); processing resolves the connection by
 * the stored Plaid item_id and runs the EXISTING transaction-sync service
 * (fetch→buffer→atomic-commit, cursor-safe) — it never re-implements sync, never
 * trusts webhook transaction details, and never touches a balance/bill/income/
 * transfer. Unknown items + unsupported codes mutate no owner data.
 * ===========================================================================*/

// Server-only (db + token decryption + provider calls).
if (typeof window !== "undefined") {
  throw new Error("webhooks service is server-only and must not be imported in the browser.");
}

import { timingSafeEqual } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { financialConnections, plaidWebhookEvents } from "@/db/schema";
import { updateItemWebhook } from "@/lib/providers/plaid/adapter";
import { decryptToken, resolveMasterKeyFromEnv } from "@/lib/providers/token-crypto";
import type { BankProvider } from "@/lib/providers/bank-provider";
import type { ProviderAccessToken, VerifiedWebhook } from "@/lib/providers/types";
import { syncConnectionTransactions } from "./transactions";
import { ConnectionError } from "./connections";

type SyncProvider = Pick<BankProvider, "syncTransactions">;

const MAX_ATTEMPTS = 5; // bounded retry per event
const STALE_PROCESSING_MINUTES = 5; // a `processing` claim older than this is recoverable
export const SUPPORTED_TYPE = "TRANSACTIONS";
export const SUPPORTED_CODE = "SYNC_UPDATES_AVAILABLE";

export function isSupportedWebhook(webhookType: string, webhookCode: string): boolean {
  return webhookType === SUPPORTED_TYPE && webhookCode === SUPPORTED_CODE;
}

/* ----------------------------------------------------------------------------
 * Internal processor authorization (Finance 1B.3B access-control correction).
 *
 * The Background Function endpoint is publicly reachable, so the webhook route
 * must prove it is the caller before any DB/Plaid work runs. We use a dedicated
 * server-only secret (PLAID_WEBHOOK_PROCESSOR_SECRET) — NEVER PLAID_SECRET, the
 * token-encryption key, a session secret, an access token, or the webhook JWT —
 * supplied in a bounded header and compared in constant time. Fails closed when
 * the secret is unset. The secret is never logged or returned. */
export const PROCESSOR_HEADER = "x-xanther-webhook-processor-key";

export function authorizeProcessorRequest(supplied: string | null | undefined): boolean {
  const expected = process.env.PLAID_WEBHOOK_PROCESSOR_SECRET;
  if (!expected) return false; // fail closed — never process while unconfigured
  if (typeof supplied !== "string" || supplied.length === 0) return false;
  const a = Buffer.from(supplied, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false; // length-mismatch is not a secret leak
  return timingSafeEqual(a, b);
}

/** True only when the internal processor secret is configured server-side. */
export function isProcessorConfigured(): boolean {
  return Boolean(process.env.PLAID_WEBHOOK_PROCESSOR_SECRET);
}

/* ----------------------------------------------------------------------------
 * Background-worker dispatch (Finance 1B.3B dispatch correction).
 *
 * The webhook route triggers the durable Background Function over HTTP. That
 * trigger must NOT silently treat a login redirect / HTML fallback / auth
 * rejection / missing-function / server error as success — doing so hid the
 * runtime defect where the owner-session middleware 307'd the worker path to
 * /login. We classify the actual response and only treat the documented Netlify
 * Background Function acceptance status (202) as a successful dispatch.
 *
 * IMPORTANT: dispatch success means only "the worker was accepted for async
 * execution" — NOT that the event was processed. The worker still authorizes
 * itself (X-Xanther-Webhook-Processor-Key) and marks the event processed only on
 * a real sync. A failed dispatch leaves the durable event at `received` for the
 * scheduled drainer to recover. */
export const BACKGROUND_FN_PATH = "/.netlify/functions/process-plaid-webhooks-background";
/** Netlify Background Functions reply 202 Accepted on accepted async invocation. */
export const BACKGROUND_ACCEPTED_STATUS = 202;

export type TriggerReason =
  | "login_redirect" // 3xx / opaqueredirect → the owner-session gate (or any redirect)
  | "html_fallback" // 200 text/html → Next.js page fallback, NOT the function
  | "unauthorized" // 401/403 → reached something that rejected us
  | "not_found" // 404 → function not routable at this path
  | "server_error" // 5xx → invocation/execution error
  | "network" // fetch threw / aborted → never reached the platform
  | "unexpected"; // any other non-202 status
export type TriggerOutcome = { ok: true; status: number } | { ok: false; reason: TriggerReason; status: number | null };

/**
 * Classify a worker-trigger response. ONLY 202 (Netlify background acceptance)
 * is success. A login redirect surfaces as a 3xx or, under `redirect: "manual"`,
 * an opaqueredirect (status 0) — both are failures, never silent successes.
 */
export function classifyTriggerResponse(status: number, contentType: string | null): TriggerOutcome {
  const ct = (contentType ?? "").toLowerCase();
  if (status === BACKGROUND_ACCEPTED_STATUS) return { ok: true, status };
  if (status === 0 || (status >= 300 && status < 400)) return { ok: false, reason: "login_redirect", status }; // incl. opaqueredirect
  if (status === 401 || status === 403) return { ok: false, reason: "unauthorized", status };
  if (status === 404) return { ok: false, reason: "not_found", status };
  if (status >= 500) return { ok: false, reason: "server_error", status };
  if (ct.includes("text/html")) return { ok: false, reason: "html_fallback", status }; // e.g. a 200 login page
  return { ok: false, reason: "unexpected", status };
}

/**
 * Fire the worker trigger and report a bounded outcome. Uses `redirect: "manual"`
 * so a login redirect is NEVER silently followed. Never throws, never logs/returns
 * the processor secret or the internal function URL. A failure leaves the durable
 * event recoverable by the scheduled drainer.
 */
export async function triggerBackgroundProcessor(baseUrl: string, signal?: AbortSignal): Promise<TriggerOutcome> {
  try {
    const res = await fetch(`${baseUrl}${BACKGROUND_FN_PATH}`, {
      method: "POST",
      redirect: "manual", // a 307→/login must surface as a failure, not be followed
      headers: { [PROCESSOR_HEADER]: process.env.PLAID_WEBHOOK_PROCESSOR_SECRET ?? "" },
      signal,
    });
    // undici returns an opaqueredirect (type set, status 0) for a manual-mode 3xx.
    if (res.type === "opaqueredirect") return { ok: false, reason: "login_redirect", status: 0 };
    return classifyTriggerResponse(res.status, res.headers.get("content-type"));
  } catch {
    return { ok: false, reason: "network", status: null }; // aborted/unreachable → recoverable
  }
}

export interface IntakeResult { eventId: number; isNew: boolean; supported: boolean; }

/**
 * Durably record a VERIFIED webhook (idempotent by body hash). A supported event
 * (TRANSACTIONS / SYNC_UPDATES_AVAILABLE) is `received` (pending processing); any
 * other validly-signed event is `ignored` (no sync). A duplicate delivery returns
 * the existing event without creating a second row or a second processing job.
 */
export async function intakeWebhook(v: VerifiedWebhook, environment: string): Promise<IntakeResult> {
  const supported = isSupportedWebhook(v.webhookType, v.webhookCode);
  const [row] = await db
    .insert(plaidWebhookEvents)
    .values({
      provider: "plaid",
      environment,
      webhookType: v.webhookType,
      webhookCode: v.webhookCode,
      providerItemId: v.providerItemId,
      providerRequestId: v.providerRequestId,
      bodyHash: v.bodyHash,
      status: supported ? "received" : "ignored",
    })
    .onConflictDoNothing({ target: plaidWebhookEvents.bodyHash })
    .returning({ id: plaidWebhookEvents.id });
  if (row) return { eventId: row.id, isNew: true, supported };
  // Duplicate (same verified body) → return the existing event; no new work.
  const [existing] = await db.select({ id: plaidWebhookEvents.id }).from(plaidWebhookEvents).where(eq(plaidWebhookEvents.bodyHash, v.bodyHash));
  return { eventId: existing?.id ?? -1, isNew: false, supported };
}

/**
 * Atomically claim a pending event so two processors can't run it at once:
 * received|failed → processing, only while under the retry cap. Returns the
 * claimed row, or null if it was already claimed/processed/exhausted.
 */
async function claimEvent(eventId: number) {
  // Claimable when received|failed, OR stuck in `processing` past the stale
  // timeout (a crashed/timed-out prior claim) — so an abandoned claim is
  // recovered, never lost. Bounded by the retry cap.
  const res = await db.execute(sql`
    UPDATE plaid_webhook_events
    SET status = 'processing', processing_started_at = now(), attempt_count = attempt_count + 1, updated_at = now()
    WHERE id = ${eventId} AND attempt_count < ${MAX_ATTEMPTS}
      AND (status IN ('received', 'failed')
           OR (status = 'processing' AND processing_started_at < now() - (${STALE_PROCESSING_MINUTES} * interval '1 minute')))
    RETURNING id, provider_item_id AS "providerItemId", attempt_count AS "attemptCount"
  `);
  return (res.rows[0] as { id: number; providerItemId: string; attemptCount: number } | undefined) ?? null;
}

export interface ProcessResult { processed: boolean; status: "processed" | "ignored" | "failed" | "skipped"; }

/**
 * Process one webhook event: claim it, resolve the connection by item id, confirm
 * owned+active+Sandbox, and run the EXISTING transaction sync. Marks `processed`
 * only on success; on failure records a bounded error and leaves it for a bounded
 * retry (cursor + imported state preserved by the sync service). Unknown item or
 * non-sandbox connection → `ignored`, mutating no owner data.
 */
export async function processWebhookEvent(eventId: number, opts?: { provider?: SyncProvider }): Promise<ProcessResult> {
  const claimed = await claimEvent(eventId);
  if (!claimed) return { processed: false, status: "skipped" };

  // Resolve the connection by the stored, non-secret item id (NEVER from a body).
  const [conn] = await db
    .select()
    .from(financialConnections)
    .where(and(eq(financialConnections.providerItemId, claimed.providerItemId), isNull(financialConnections.deletedAt)));

  if (!conn || conn.environment !== "sandbox" || conn.status === "revoked") {
    // Validly verified but nothing actionable → ignore; mutate no owner data.
    await db.update(plaidWebhookEvents).set({ status: "ignored", processedAt: new Date(), lastErrorCode: !conn ? "UNKNOWN_ITEM" : "NOT_SANDBOX", updatedAt: new Date() }).where(eq(plaidWebhookEvents.id, eventId));
    return { processed: false, status: "ignored" };
  }

  try {
    await syncConnectionTransactions(conn.userId, conn.id, opts); // existing fetch→buffer→atomic sync
    await db.update(plaidWebhookEvents).set({ status: "processed", processedAt: new Date(), lastErrorCode: null, lastErrorMessage: null, updatedAt: new Date() }).where(eq(plaidWebhookEvents.id, eventId));
    return { processed: true, status: "processed" };
  } catch (e) {
    // Preserve the event for a bounded retry; the sync service already preserved
    // the prior cursor + imported state on failure. No financial description/amount
    // is logged.
    const code = e instanceof ConnectionError ? `SYNC_${e.status}` : "SYNC_FAILED";
    await db.update(plaidWebhookEvents).set({ status: "failed", lastErrorCode: code, lastErrorMessage: "Transaction sync did not complete; will retry.", updatedAt: new Date() }).where(eq(plaidWebhookEvents.id, eventId));
    return { processed: false, status: "failed" };
  }
}

/** Drain up to `limit` pending/retryable supported events. Used synchronously by
 * the webhook route and by the scheduled drainer. */
export async function processPendingWebhookEvents(limit = 10, opts?: { provider?: SyncProvider }): Promise<{ processed: number; ignored: number; failed: number }> {
  // Recoverable = received|failed OR a stale `processing` claim, under the retry
  // cap. (Includes events a prior worker abandoned.)
  const pending = await db.execute(sql`
    SELECT id FROM plaid_webhook_events
    WHERE webhook_code = ${SUPPORTED_CODE} AND attempt_count < ${MAX_ATTEMPTS}
      AND (status IN ('received', 'failed')
           OR (status = 'processing' AND processing_started_at < now() - (${STALE_PROCESSING_MINUTES} * interval '1 minute')))
    ORDER BY received_at ASC
    LIMIT ${Math.min(limit, 50)}
  `);
  const counts = { processed: 0, ignored: 0, failed: 0 };
  for (const e of pending.rows as { id: number }[]) {
    const r = await processWebhookEvent(e.id, opts);
    if (r.status === "processed") counts.processed++;
    else if (r.status === "ignored") counts.ignored++;
    else if (r.status === "failed") counts.failed++;
  }
  return counts;
}

/**
 * Set/refresh an existing connection's Plaid Item webhook URL (Sandbox). Fails
 * closed if `PLAID_WEBHOOK_URL` is not configured. Never exposes the access token.
 */
export async function configureConnectionWebhook(userId: number, connectionId: number): Promise<{ ok: boolean }> {
  const url = process.env.PLAID_WEBHOOK_URL;
  if (!url) throw new ConnectionError(503, "Automatic updates are not configured (webhook URL missing).");
  const [conn] = await db.select().from(financialConnections).where(and(eq(financialConnections.id, connectionId), eq(financialConnections.userId, userId), isNull(financialConnections.deletedAt)));
  if (!conn) throw new ConnectionError(404, "Connection not found.");
  if (conn.environment !== "sandbox") throw new ConnectionError(400, "Only Sandbox connections are supported in this phase.");
  const key = resolveMasterKeyFromEnv(1);
  if (!key) throw new ConnectionError(503, "Bank token encryption is not configured.");
  let token: ProviderAccessToken;
  try {
    token = decryptToken({ v: conn.accessTokenEnvelopeVersion, keyVersion: conn.accessTokenKeyVersion, nonce: conn.accessTokenNonce, ciphertext: conn.accessTokenCipher, tag: conn.accessTokenTag }, key) as ProviderAccessToken;
  } catch {
    throw new ConnectionError(500, "Could not access the bank connection.");
  }
  await updateItemWebhook(token, url);
  return { ok: true };
}

export interface AutoSyncStatus {
  configured: boolean; // PLAID_WEBHOOK_URL is set (automatic updates possible)
  processorConfigured: boolean; // PLAID_WEBHOOK_PROCESSOR_SECRET is set (background processing healthy)
  lastSyncedAt: string | null; // most recent successful transaction sync (any connection)
  pending: boolean; // a verified notification is received/processing (sync in progress)
  failed: boolean; // a recoverable failed event exists (will retry; manual still available)
}

/** Bounded, nonsecret automatic-update status for the owner-facing UI. Never
 * exposes the webhook URL, item id, or any secret. */
export async function getAutoSyncStatus(userId: number): Promise<AutoSyncStatus> {
  const configured = Boolean(process.env.PLAID_WEBHOOK_URL);
  const processorConfigured = isProcessorConfigured();
  const conns = await db
    .select({ providerItemId: financialConnections.providerItemId, lastTransactionSyncedAt: financialConnections.lastTransactionSyncedAt })
    .from(financialConnections)
    .where(and(eq(financialConnections.userId, userId), isNull(financialConnections.deletedAt)));
  const itemIds = conns.map((c) => c.providerItemId);
  const syncedTimes = conns.map((c) => c.lastTransactionSyncedAt).filter((d): d is Date => d != null).map((d) => d.toISOString()).sort();
  const lastSyncedAt = syncedTimes.length ? syncedTimes[syncedTimes.length - 1] : null;
  let pending = false, failed = false;
  if (itemIds.length) {
    const evs = await db
      .select({ status: plaidWebhookEvents.status, attemptCount: plaidWebhookEvents.attemptCount })
      .from(plaidWebhookEvents)
      .where(and(inArray(plaidWebhookEvents.providerItemId, itemIds), eq(plaidWebhookEvents.webhookCode, SUPPORTED_CODE)));
    pending = evs.some((e) => e.status === "received" || e.status === "processing");
    failed = evs.some((e) => e.status === "failed" && e.attemptCount < MAX_ATTEMPTS);
  }
  return { configured, processorConfigured, lastSyncedAt, pending, failed };
}
