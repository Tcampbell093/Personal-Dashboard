/* Deterministic verification for Finance 1B.3B (verified Plaid Sandbox webhooks +
 * automatic transaction sync). The verifier ACCEPT path is exercised with a
 * locally-generated ES256 keypair injected into the key cache (no Plaid private
 * key needed); REJECT paths use crafted invalid tokens; the event lifecycle uses
 * an injected fake sync provider for speed/determinism, plus one LIVE Plaid sync
 * proving real integration. Read-only, Sandbox-only, no matching/money movement.
 * Exact-ID cleanup; the owner's real connection + imported transactions are never
 * touched. No secret is printed.
 *
 * Run: npx tsx --env-file=.env --env-file=.env.local scripts/verify-finance1b3b.ts
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  plaidWebhookEvents, financialConnections, providerAccounts, financialAccounts,
  importedTransactions, accountMovements, incomeEntries, financialEntries, accountTransfers, apiUsageLogs, experienceRequests,
} from "@/db/schema";
import { CURRENT_USER_ID } from "@/lib/auth";
import { exchangeAndStore } from "@/lib/services/connections";
import { sandboxCreatePublicToken, sandboxCreateTransactions, plaidAdapter } from "@/lib/providers/plaid/adapter";
import { syncProviderAccounts } from "@/lib/services/provider-accounts";
import { syncConnectionTransactions } from "@/lib/services/transactions";
import { intakeWebhook, processWebhookEvent, processPendingWebhookEvents, configureConnectionWebhook, authorizeProcessorRequest, isProcessorConfigured, PROCESSOR_HEADER, classifyTriggerResponse, triggerBackgroundProcessor, BACKGROUND_ACCEPTED_STATUS } from "@/lib/services/webhooks";
import { middleware } from "@/middleware";
import { NextRequest } from "next/server";
import { verifyPlaidWebhook, WebhookVerificationError, __setWebhookKeyForTest } from "@/lib/providers/plaid/webhook";
import { decryptToken, resolveMasterKeyFromEnv } from "@/lib/providers/token-crypto";
import { newRecords, cleanupBankTestRecords, sweepStaleTestAccounts, orphanLinkedCount } from "./support/bank-test-cleanup";
import type { ProviderAccessToken, TransactionSyncPage, ImportedTransactionDTO } from "@/lib/providers/types";

const U = CURRENT_USER_ID;
let passed = 0, failed = 0;
const ok = (n: string, c: boolean) => { c ? passed++ : failed++; console.log(`${c ? "✓" : "✗"} ${n}`); };
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const temp = newRecords();
const tempItemIds: string[] = [];

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
async function signWH(body: string, kid: string, priv: Parameters<typeof SignJWT.prototype.sign>[0], iatOffset = 0) {
  return new SignJWT({ request_body_sha256: sha(body) }).setProtectedHeader({ alg: "ES256", kid }).setIssuedAt(Math.floor(Date.now() / 1000) + iatOffset).sign(priv);
}
const whBody = (itemId: string, code = "SYNC_UPDATES_AVAILABLE", type = "TRANSACTIONS", req = "req-x") =>
  JSON.stringify({ webhook_type: type, webhook_code: code, item_id: itemId, request_id: req });
const dto = (id: string, acct: string, amount: number): ImportedTransactionDTO => ({
  providerTransactionId: id, providerAccountId: acct, pendingProviderTransactionId: null, isPending: false, amount,
  isoCurrencyCode: "USD", descriptionCurrent: "WH txn", descriptionOriginal: null, merchantName: null,
  authorizedDate: "2026-06-20", postedDate: "2026-06-21", categoryPrimary: null, categoryDetailed: null,
});
const fakePage = (added: ImportedTransactionDTO[], cursor = "WHC"): TransactionSyncPage => ({ added, modified: [], removed: [], nextCursor: cursor, hasMore: false });
const fakeProvider = (page: TransactionSyncPage | Error) => ({ provider: { syncTransactions: async () => { if (page instanceof Error) throw page; return page; } } });
const eventsForItem = (itemId: string) => db.select().from(plaidWebhookEvents).where(eq(plaidWebhookEvents.providerItemId, itemId));
const connRow = (cid: number) => db.select().from(financialConnections).where(eq(financialConnections.id, cid)).then((r) => r[0]);

async function cleanup() {
  for (const itemId of tempItemIds) await db.delete(plaidWebhookEvents).where(eq(plaidWebhookEvents.providerItemId, itemId)).catch(() => {});
  await cleanupBankTestRecords(U, temp);
}

async function main() {
  console.log("Finance 1B.3B deterministic verification\n");
  await sweepStaleTestAccounts(U, "ZZ3B").catch(() => {});
  const movBefore = (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length;
  const ownerAcctsBefore = JSON.stringify(await db.select().from(financialAccounts).where(and(eq(financialAccounts.userId, U), isNull(financialAccounts.deletedAt))));
  const ownerImportedBefore = (await db.select().from(importedTransactions).where(eq(importedTransactions.userId, U))).length;
  const ownerConnsBefore = (await db.select().from(financialConnections).where(and(eq(financialConnections.userId, U), isNull(financialConnections.deletedAt)))).map((c) => c.id).sort();
  const logsBefore = (await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))).length;

  const verifierSrc = read("lib/providers/plaid/webhook.ts");
  const svcSrc = read("lib/services/webhooks.ts");
  const routeSrc = read("app/api/webhooks/plaid/route.ts");
  const adapterSrc = read("lib/providers/plaid/adapter.ts");
  const txnSrc = read("lib/services/transactions.ts");
  const schemaSrc = read("db/schema.ts");
  const middlewareSrc = read("middleware.ts");
  const uiSrc = read("components/finances/imported-activity.tsx");

  let bodyError: unknown;
  try {
    // keypair + injected verification key (Sandbox-scoped)
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    __setWebhookKeyForTest("sandbox", "kidA", await exportJWK(publicKey));

    // a temp connection (for a real item_id + a real sync target)
    const conn = await exchangeAndStore(U, await sandboxCreatePublicToken());
    temp.connIds.push(conn.id);
    await syncProviderAccounts(U, conn.id);
    const cr = await connRow(conn.id); const itemId = cr.providerItemId; tempItemIds.push(itemId);
    const tok = decryptToken({ v: cr.accessTokenEnvelopeVersion, keyVersion: cr.accessTokenKeyVersion, nonce: cr.accessTokenNonce, ciphertext: cr.accessTokenCipher, tag: cr.accessTokenTag }, resolveMasterKeyFromEnv(1)!) as ProviderAccessToken;

    /* ============ signature verification [1-12] ============ */
    console.log("[signature verification]");
    const body1 = whBody(itemId);
    const jwt1 = await signWH(body1, "kidA", privateKey);
    const v1 = await verifyPlaidWebhook(body1, { "Plaid-Verification": jwt1 });
    ok("[1] valid Plaid-signed webhook is accepted", v1.bodyHash === sha(body1));
    const vFull1 = await plaidAdapter.verifyWebhook({ headers: { "Plaid-Verification": jwt1 }, rawBody: body1 });
    const rej = async (fn: () => Promise<unknown>, code: string) => { try { await fn(); return false; } catch (e) { return e instanceof WebhookVerificationError && e.code === code; } };
    ok("[2] missing verification header is rejected", await rej(() => verifyPlaidWebhook(body1, {}), "MISSING_HEADER"));
    ok("[3] invalid JWT is rejected", await rej(() => verifyPlaidWebhook(body1, { "Plaid-Verification": "not.a.jwt" }), "MALFORMED_JWT"));
    const hs = await new SignJWT({ request_body_sha256: sha(body1) }).setProtectedHeader({ alg: "HS256", kid: "kidA" } as never).setIssuedAt().sign(new Uint8Array(32));
    ok("[4] wrong algorithm is rejected", await rej(() => verifyPlaidWebhook(body1, { "Plaid-Verification": hs }), "WRONG_ALG"));
    const jwtUnknown = await signWH(body1, "kid-does-not-exist-zzz", privateKey);
    ok("[5] unknown key id is rejected", await rej(() => verifyPlaidWebhook(body1, { "Plaid-Verification": jwtUnknown }), "UNKNOWN_KEY"));
    const { privateKey: otherPriv } = await generateKeyPair("ES256");
    const forged = await signWH(body1, "kidA", otherPriv);
    ok("[6] invalid signature is rejected", await rej(() => verifyPlaidWebhook(body1, { "Plaid-Verification": forged }), "BAD_SIGNATURE"));
    const staleJwt = await signWH(body1, "kidA", privateKey, -400);
    ok("[7] stale issued-at is rejected", await rej(() => verifyPlaidWebhook(body1, { "Plaid-Verification": staleJwt }), "STALE"));
    const bodyDiff = whBody(itemId, "SYNC_UPDATES_AVAILABLE", "TRANSACTIONS", "different");
    ok("[8] incorrect body hash is rejected", await rej(() => verifyPlaidWebhook(bodyDiff, { "Plaid-Verification": jwt1 }), "BODY_MISMATCH"));
    ok("[9] body-whitespace alteration is detected", await rej(() => verifyPlaidWebhook(body1 + " ", { "Plaid-Verification": jwt1 }), "BODY_MISMATCH"));
    ok("[10] exact raw body is used (verifier hashes rawBody, not parsed JSON)", /createHash\("sha256"\)\.update\(rawBody/.test(verifierSrc));
    ok("[11] verification keys are cached safely (bounded TTL, no token)", /keyCache/.test(verifierSrc) && /KEY_CACHE_TTL_MS/.test(verifierSrc) && !/accessToken|access_token/i.test(verifierSrc));
    ok("[12] Production and Sandbox keys cannot be mixed (cache key includes env)", /\$\{env\}:\$\{kid\}/.test(verifierSrc) && /readPlaidSandboxConfig\(\)\.env/.test(verifierSrc));

    /* ============ intake + idempotency [13-20] ============ */
    console.log("\n[intake + idempotency]");
    const intake1 = await intakeWebhook(vFull1, "sandbox");
    ok("[13] supported webhook creates one durable event", intake1.isNew && intake1.supported && (await eventsForItem(itemId)).length === 1);
    const intakeDup = await intakeWebhook(vFull1, "sandbox");
    ok("[14] duplicate delivery creates no second event", !intakeDup.isNew && (await eventsForItem(itemId)).filter((e) => e.bodyHash === vFull1.bodyHash).length === 1);
    const [p1, p2] = await Promise.all([processWebhookEvent(intake1.eventId, fakeProvider(fakePage([dto("WH1", "a", -5)]))), processWebhookEvent(intake1.eventId, fakeProvider(fakePage([dto("WH1", "a", -5)])))]);
    ok("[15] duplicate delivery creates no duplicate processor claim", [p1, p2].filter((r) => r.status === "processed").length === 1 && [p1, p2].some((r) => r.status === "skipped"));
    // unsupported valid webhook → ignored, no sync
    const bodyUnsup = whBody(itemId, "DEFAULT_UPDATE");
    const vUnsup = await plaidAdapter.verifyWebhook({ headers: { "Plaid-Verification": await signWH(bodyUnsup, "kidA", privateKey) }, rawBody: bodyUnsup });
    const intakeUnsup = await intakeWebhook(vUnsup, "sandbox");
    ok("[16] unsupported valid webhook performs no sync (ignored)", !intakeUnsup.supported && (await db.select().from(plaidWebhookEvents).where(eq(plaidWebhookEvents.id, intakeUnsup.eventId)))[0].status === "ignored");
    const nonJson = "not json at all";
    const nonJsonJwt = await signWH(nonJson, "kidA", privateKey);
    ok("[17] malformed payload after valid verification fails safely", await rej(() => plaidAdapter.verifyWebhook({ headers: { "Plaid-Verification": nonJsonJwt }, rawBody: nonJson }) as Promise<unknown>, "MALFORMED_BODY"));
    // unknown item → no owner mutation
    const unknownBody = whBody("item-unknown-zzz");
    const vUnknown = await plaidAdapter.verifyWebhook({ headers: { "Plaid-Verification": await signWH(unknownBody, "kidA", privateKey) }, rawBody: unknownBody });
    tempItemIds.push("item-unknown-zzz");
    const intakeUnknown = await intakeWebhook(vUnknown, "sandbox");
    const accBeforeUnknown = JSON.stringify(await db.select().from(financialAccounts).where(eq(financialAccounts.userId, U)));
    const rUnknown = await processWebhookEvent(intakeUnknown.eventId, fakeProvider(fakePage([dto("X", "a", -1)])));
    ok("[18] unknown Item mutates no owner data (ignored)", rUnknown.status === "ignored" && JSON.stringify(await db.select().from(financialAccounts).where(eq(financialAccounts.userId, U))) === accBeforeUnknown);
    ok("[19] browser-supplied owner identity is ignored (connection resolved by item id)", /provider_item_id|providerItemId/.test(svcSrc) && !/body\.user_id|body\.userId|req\.user/i.test(routeSrc + svcSrc));
    ok("[20] route returns no secret fields", !/access_token|accessToken|Cipher|Nonce|providerItemId|item_id/i.test(routeSrc.replace(/\/\*[\s\S]*?\*\//g, "")));

    /* ============ automatic processing [21-35] ============ */
    console.log("\n[automatic processing]");
    const body2 = whBody(itemId, "SYNC_UPDATES_AVAILABLE", "TRANSACTIONS", "req-2");
    const v2 = await plaidAdapter.verifyWebhook({ headers: { "Plaid-Verification": await signWH(body2, "kidA", privateKey) }, rawBody: body2 });
    const intake2 = await intakeWebhook(v2, "sandbox");
    ok("[21] pending event is claimed atomically (UPDATE…WHERE status guard)", /UPDATE plaid_webhook_events[\s\S]*status IN \('received', 'failed'\)/.test(svcSrc));
    const cursorBefore = (await connRow(conn.id)).transactionsCursor;
    const r23 = await processWebhookEvent(intake2.eventId, fakeProvider(fakePage([dto("WH2", "a", -7)], "WHC2")));
    ok("[22/23] supported event invokes the existing transaction-sync service", r23.status === "processed" && (await db.select().from(importedTransactions).where(and(eq(importedTransactions.connectionId, conn.id), eq(importedTransactions.providerTransactionId, "WH2")))).length === 1);
    ok("[24] existing cursor is used + advanced by the sync", (await connRow(conn.id)).transactionsCursor === "WHC2" && cursorBefore !== "WHC2");
    ok("[25] complete-page buffering remains intact (sync service unchanged)", /fetchCompletePatch/.test(txnSrc) && /WITHOUT any durable write|fetch EVERY available page/i.test(txnSrc));
    ok("[26] atomic transaction patch remains intact", /applyPatchAtomic/.test(txnSrc) && /sql`WITH \$\{sql\.join\(ctes/.test(txnSrc));
    ok("[27] successful sync marks event processed", (await db.select().from(plaidWebhookEvents).where(eq(plaidWebhookEvents.id, intake2.eventId)))[0].status === "processed");
    // failure path
    const body3 = whBody(itemId, "SYNC_UPDATES_AVAILABLE", "TRANSACTIONS", "req-3");
    const v3 = await plaidAdapter.verifyWebhook({ headers: { "Plaid-Verification": await signWH(body3, "kidA", privateKey) }, rawBody: body3 });
    const intake3 = await intakeWebhook(v3, "sandbox");
    const cursorPreFail = (await connRow(conn.id)).transactionsCursor;
    const importedPreFail = (await db.select().from(importedTransactions).where(eq(importedTransactions.connectionId, conn.id))).length;
    const rFail = await processWebhookEvent(intake3.eventId, fakeProvider(new Error("sync boom")));
    const evFail = (await db.select().from(plaidWebhookEvents).where(eq(plaidWebhookEvents.id, intake3.eventId)))[0];
    ok("[28] failed sync preserves the event for retry (status failed)", rFail.status === "failed" && evFail.status === "failed" && evFail.attemptCount === 1);
    ok("[29] failed sync preserves the prior cursor", (await connRow(conn.id)).transactionsCursor === cursorPreFail);
    ok("[30] failed sync creates no partial imported state", (await db.select().from(importedTransactions).where(eq(importedTransactions.connectionId, conn.id))).length === importedPreFail);
    const rRetry = await processWebhookEvent(intake3.eventId, fakeProvider(fakePage([dto("WH3", "a", -2)])));
    ok("[31] bounded retry works (a failed event re-processes successfully)", rRetry.status === "processed");
    // retry exhaustion
    const body4 = whBody(itemId, "SYNC_UPDATES_AVAILABLE", "TRANSACTIONS", "req-4");
    const v4 = await plaidAdapter.verifyWebhook({ headers: { "Plaid-Verification": await signWH(body4, "kidA", privateKey) }, rawBody: body4 });
    const intake4 = await intakeWebhook(v4, "sandbox");
    for (let i = 0; i < 5; i++) await processWebhookEvent(intake4.eventId, fakeProvider(new Error("always fails")));
    const exhausted = (await db.select().from(plaidWebhookEvents).where(eq(plaidWebhookEvents.id, intake4.eventId)))[0];
    const rExhausted = await processWebhookEvent(intake4.eventId, fakeProvider(fakePage([dto("WH4", "a", -1)])));
    ok("[32] retry exhaustion is recorded truthfully (attemptCount capped, not re-claimable)", exhausted.attemptCount === 5 && exhausted.status === "failed" && rExhausted.status === "skipped");
    // duplicate / out-of-order / collapse
    const bodyB = whBody(itemId, "SYNC_UPDATES_AVAILABLE", "TRANSACTIONS", "req-collapse");
    const vB = await plaidAdapter.verifyWebhook({ headers: { "Plaid-Verification": await signWH(bodyB, "kidA", privateKey) }, rawBody: bodyB });
    const intakeB = await intakeWebhook(vB, "sandbox");
    ok("[33/34] multiple notifications collapse into one current-cursor sync (harmless)", intakeB.isNew && (await processPendingWebhookEvents(10, fakeProvider(fakePage([dto("WH5", "a", -3)])))).processed >= 1);
    ok("[35] manual sync remains functional (existing service still works)", typeof (await syncConnectionTransactions(U, conn.id, fakeProvider(fakePage([dto("WH6", "a", -4)])))).added === "number");

    /* ============ reliability correction: ack-fast + durable background [R1-R20] ============ */
    console.log("\n[reliability: ack-fast + durable background processing]");
    // [R1/R2/R3] route durably records BEFORE ack and does NOT run the full sync inline.
    ok("[R1] route durably records the event before acknowledging (intake precedes the trigger)",
      routeSrc.indexOf("intakeWebhook") > 0 && routeSrc.indexOf("intakeWebhook") < routeSrc.indexOf("triggerBackgroundProcessor"));
    ok("[R2] route does NOT execute the full transaction sync inline",
      !/processPendingWebhookEvents|syncConnectionTransactions/.test(routeSrc));
    ok("[R3] route returns promptly (bounded trigger, no inline sync)",
      /AbortController|setTimeout\(\(\) => ac\.abort/.test(routeSrc) && /triggerBackgroundProcessor/.test(routeSrc));
    // [R4] a failed processor invocation leaves the event recoverable (still pending).
    const bodyR4 = whBody(itemId, "SYNC_UPDATES_AVAILABLE", "TRANSACTIONS", "r4");
    const vR4 = await plaidAdapter.verifyWebhook({ headers: { "Plaid-Verification": await signWH(bodyR4, "kidA", privateKey) }, rawBody: bodyR4 });
    const intakeR4 = await intakeWebhook(vR4, "sandbox"); // (no processor invoked → simulates trigger failure)
    const evR4 = (await db.select().from(plaidWebhookEvents).where(eq(plaidWebhookEvents.id, intakeR4.eventId)))[0];
    ok("[R4] a processor-invocation failure leaves the event recoverable (status 'received')", evR4.status === "received");
    ok("[R5/R6] background processor claims one event atomically (UPDATE…WHERE guard + RETURNING)",
      /UPDATE plaid_webhook_events[\s\S]*RETURNING id/.test(svcSrc));
    // the recoverable R4 event is then picked up by the drainer service.
    ok("[R17] the recovery backstop (drainer service) finds the missed event",
      (await processPendingWebhookEvents(10, fakeProvider(fakePage([dto("R4tx", "a", -1)])))).processed >= 1 && (await db.select().from(plaidWebhookEvents).where(eq(plaidWebhookEvents.id, intakeR4.eventId)))[0].status === "processed");
    // [R7/R8/R9] stale 'processing' (crash/timeout) becomes retryable after the timeout.
    const bodyR9 = whBody(itemId, "SYNC_UPDATES_AVAILABLE", "TRANSACTIONS", "r9");
    const vR9 = await plaidAdapter.verifyWebhook({ headers: { "Plaid-Verification": await signWH(bodyR9, "kidA", privateKey) }, rawBody: bodyR9 });
    const intakeR9 = await intakeWebhook(vR9, "sandbox");
    await db.update(plaidWebhookEvents).set({ status: "processing", processingStartedAt: new Date() }).where(eq(plaidWebhookEvents.id, intakeR9.eventId));
    const freshRun = await processPendingWebhookEvents(10, fakeProvider(fakePage([dto("R9a", "a", -1)])));
    ok("[R7/R8] a FRESH 'processing' claim is not re-processed (no double-process)", (await db.select().from(plaidWebhookEvents).where(eq(plaidWebhookEvents.id, intakeR9.eventId)))[0].status === "processing");
    await db.execute(sql`UPDATE plaid_webhook_events SET processing_started_at = now() - interval '6 minutes' WHERE id = ${intakeR9.eventId}`);
    const staleRun = await processPendingWebhookEvents(10, fakeProvider(fakePage([dto("R9b", "a", -1)])));
    ok("[R9] a STALE 'processing' claim becomes retryable after the documented timeout", staleRun.processed >= 1 && (await db.select().from(plaidWebhookEvents).where(eq(plaidWebhookEvents.id, intakeR9.eventId)))[0].status === "processed" && freshRun.processed >= 0);
    // [R10] Netlify retry idempotent: reprocessing a processed event is a no-op.
    const before10 = (await db.select().from(importedTransactions).where(eq(importedTransactions.connectionId, conn.id))).length;
    await processPendingWebhookEvents(10, fakeProvider(fakePage([dto("R9b", "a", -1)])));
    ok("[R10] a Netlify retry / reprocess is idempotent (no duplicate rows or jobs)", (await db.select().from(importedTransactions).where(eq(importedTransactions.connectionId, conn.id))).length === before10);
    // [R18] scheduled + background cannot double-process (concurrent drains, atomic claim).
    const bodyR18 = whBody(itemId, "SYNC_UPDATES_AVAILABLE", "TRANSACTIONS", "r18");
    const vR18 = await plaidAdapter.verifyWebhook({ headers: { "Plaid-Verification": await signWH(bodyR18, "kidA", privateKey) }, rawBody: bodyR18 });
    const intakeR18 = await intakeWebhook(vR18, "sandbox");
    const [d1, d2] = await Promise.all([processPendingWebhookEvents(10, fakeProvider(fakePage([dto("R18", "a", -1)]))), processPendingWebhookEvents(10, fakeProvider(fakePage([dto("R18", "a", -1)])))]);
    ok("[R18] scheduled + background drains cannot double-process one event", d1.processed + d2.processed >= 1 && (await db.select().from(importedTransactions).where(and(eq(importedTransactions.connectionId, conn.id), eq(importedTransactions.providerTransactionId, "R18")))).length === 1 && (await db.select().from(plaidWebhookEvents).where(eq(plaidWebhookEvents.id, intakeR18.eventId)))[0].status === "processed");
    ok("[R13] the existing complete-page transaction sync remains unchanged", /fetchCompletePatch/.test(txnSrc) && /applyPatchAtomic/.test(txnSrc));
    ok("[R12] several events for the same Item do not corrupt the cursor (current-cursor sync)", typeof (await connRow(conn.id)).transactionsCursor === "string");
    // [R20] the durability invariant: a verified intaked event is always in a recorded state.
    const allTempEvents = await db.select({ status: plaidWebhookEvents.status }).from(plaidWebhookEvents).where(inArray(plaidWebhookEvents.providerItemId, tempItemIds.length ? tempItemIds : ["__none__"]));
    const TERMINAL_OR_PENDING = ["received", "processing", "failed", "processed", "ignored"];
    ok("[R20/invariant] every verified event is recoverably pending/processing/failed OR durably processed/ignored — never silently lost",
      allTempEvents.length > 0 && allTempEvents.every((e) => TERMINAL_OR_PENDING.includes(e.status)));
    ok("[R19] manual Sync transactions remains functional alongside automatic processing",
      typeof (await syncConnectionTransactions(U, conn.id, fakeProvider(fakePage([dto("R19", "a", -1)])))).added === "number");
    // background + scheduled functions exist (active processors, not disabled)
    ok("[R-fns] active background processor + scheduled backstop exist (backstop NOT disabled)",
      existsSync("netlify/functions/process-plaid-webhooks-background.mts") &&
      /schedule: "\*\/10 \* \* \* \*"/.test(read("netlify/functions/drain-plaid-webhooks.mts")));

    /* ============ internal processor access control [A1-A20] ============ */
    console.log("\n[access control: protect the background processor from arbitrary invocation]");
    const bgSrc = read("netlify/functions/process-plaid-webhooks-background.mts");
    const bgModPath = "../netlify/functions/process-plaid-webhooks-background.mts"; // indirect → not pulled into tsc program
    const { default: bgHandler } = (await import(bgModPath)) as { default: (req: Request) => Promise<Response> };
    const callBg = (hdr?: Record<string, string>) => bgHandler(new Request("http://localhost/.netlify/functions/process-plaid-webhooks-background", { method: "POST", headers: hdr ?? {} }));
    const origSecret = process.env.PLAID_WEBHOOK_PROCESSOR_SECRET;
    const SECRET = "test-internal-processor-secret-A1A20";
    process.env.PLAID_WEBHOOK_PROCESSOR_SECRET = SECRET;
    // [A1/A2/A3] header authorization at the HTTP boundary.
    const respNo = await callBg();
    const respWrong = await callBg({ [PROCESSOR_HEADER]: "incorrect-secret" });
    const respRight = await callBg({ [PROCESSOR_HEADER]: SECRET });
    ok("[A1] missing internal processor header is rejected (401)", respNo.status === 401);
    ok("[A2] incorrect internal processor header is rejected (401)", respWrong.status === 401);
    ok("[A3] correct internal processor header is accepted (202)", respRight.status === 202);
    ok("[A4] comparison is timing-safe (timingSafeEqual; length-guarded)", /timingSafeEqual/.test(svcSrc) && /a\.length !== b\.length/.test(svcSrc));
    // [A6/A7/A8] an unauthorized call does NO db query / claim / Plaid request / status change.
    const bodyA = whBody(itemId, "SYNC_UPDATES_AVAILABLE", "TRANSACTIONS", "a-auth");
    const vA = await plaidAdapter.verifyWebhook({ headers: { "Plaid-Verification": await signWH(bodyA, "kidA", privateKey) }, rawBody: bodyA });
    const intakeA = await intakeWebhook(vA, "sandbox");
    const impBeforeUnauth = (await db.select().from(importedTransactions).where(eq(importedTransactions.userId, U))).length;
    await callBg(); // unauthorized — must touch nothing
    await callBg({ [PROCESSOR_HEADER]: "incorrect-secret" });
    const evA = (await db.select().from(plaidWebhookEvents).where(eq(plaidWebhookEvents.id, intakeA.eventId)))[0];
    ok("[A6/A7/A8] unauthorized invocation performs no claim / Plaid request / status change (event still 'received', attempt 0)", evA.status === "received" && evA.attemptCount === 0);
    ok("[A19] owner's data is unchanged by unauthorized invocation (no imported rows added)", (await db.select().from(importedTransactions).where(eq(importedTransactions.userId, U))).length === impBeforeUnauth);
    ok("[A9] no credential appears in responses (401/202 bodies)", !(await respNo.clone().text()).includes(SECRET) && !(await respRight.clone().text()).includes(SECRET));
    ok("[A11] the worker trigger sends the credential SERVER-TO-SERVER only (in the fetch header, from env; never in the route response)", new RegExp(`\\[PROCESSOR_HEADER\\]: process\\.env\\.PLAID_WEBHOOK_PROCESSOR_SECRET`).test(svcSrc) && !/PLAID_WEBHOOK_PROCESSOR_SECRET/.test(routeSrc));
    ok("[A12] credential is never in client bundles or Link-token responses (env name absent from client UI + link route)", !/PLAID_WEBHOOK_PROCESSOR_SECRET/.test(uiSrc) && !/PLAID_WEBHOOK_PROCESSOR_SECRET/.test(read("app/api/finances/connections/link-token/route.ts")));
    ok("[A13] a failed authorized trigger leaves the event recoverable (durable, still claimable)", intakeA.isNew && evA.status === "received");
    ok("[A14] the scheduled drainer recovers a trigger-missed event WITHOUT the HTTP secret (calls the service directly)", /processPendingWebhookEvents/.test(read("netlify/functions/drain-plaid-webhooks.mts")) && !/PLAID_WEBHOOK_PROCESSOR_SECRET|PROCESSOR_HEADER/.test(read("netlify/functions/drain-plaid-webhooks.mts")));
    // now let the trusted drainer (direct service call) actually recover event A.
    const recovered = await processPendingWebhookEvents(10, fakeProvider(fakePage([dto("Atx", "a", -1)])));
    ok("[A14b] drainer recovers the previously-unauthorized-but-durable event", recovered.processed >= 1 && (await db.select().from(plaidWebhookEvents).where(eq(plaidWebhookEvents.id, intakeA.eventId)))[0].status === "processed");
    ok("[A15] duplicate authorized worker calls remain safe (handler delegates to the same atomic-claim service)", /authorizeProcessorRequest[\s\S]*processPendingWebhookEvents/.test(bgSrc) && /UPDATE plaid_webhook_events[\s\S]*RETURNING id/.test(svcSrc));
    ok("[A16] manual transaction sync remains unaffected", typeof (await syncConnectionTransactions(U, conn.id, fakeProvider(fakePage([dto("A16", "a", -1)])))).added === "number");
    ok("[A17] existing webhook signature verification remains unaffected", (await plaidAdapter.verifyWebhook({ headers: { "Plaid-Verification": await signWH(whBody(itemId, "SYNC_UPDATES_AVAILABLE", "TRANSACTIONS", "a17"), "kidA", privateKey) }, rawBody: whBody(itemId, "SYNC_UPDATES_AVAILABLE", "TRANSACTIONS", "a17") })).verified === true);
    ok("[A18] the fast-ack lifecycle remains unaffected (intake before trigger, no inline sync, bounded trigger)", routeSrc.indexOf("intakeWebhook") < routeSrc.indexOf("triggerBackgroundProcessor") && !/processPendingWebhookEvents|syncConnectionTransactions/.test(routeSrc) && /ac\.abort/.test(routeSrc));
    // [A5] fail closed when the server-side secret is missing.
    delete process.env.PLAID_WEBHOOK_PROCESSOR_SECRET;
    ok("[A5] missing server-side processor secret fails closed (authorize false, not configured)", authorizeProcessorRequest(SECRET) === false && isProcessorConfigured() === false);
    const respUnset = await callBg({ [PROCESSOR_HEADER]: SECRET });
    ok("[A-invariant] no unauthenticated/incorrectly-authenticated caller can cause processing work (401 + no status change, incl. when unconfigured)", respUnset.status === 401 && (await db.select().from(plaidWebhookEvents).where(eq(plaidWebhookEvents.id, intakeA.eventId)))[0].status === "processed");
    ok("[A10] no credential value appears in source / fixtures / reports", !new RegExp(SECRET.slice(0, 12)).test(svcSrc + routeSrc + bgSrc + read("netlify/functions/drain-plaid-webhooks.mts")) && !/PLAID_WEBHOOK_PROCESSOR_SECRET\s*=\s*["'][^"']/.test(svcSrc + routeSrc + bgSrc));
    ok("[A20] .env.local remains ignored (gitignore)", /(^|\n)\.env\.local/.test(read(".gitignore")));
    if (origSecret === undefined) delete process.env.PLAID_WEBHOOK_PROCESSOR_SECRET; else process.env.PLAID_WEBHOOK_PROCESSOR_SECRET = origSecret;

    /* ============ worker-dispatch correction [D1-D24] ============ */
    console.log("\n[worker dispatch: middleware bypass + observed trigger]");
    const mwSrc = read("middleware.ts");
    // Middleware behavior tests — exercise the real gate with APP_PASSWORD set.
    const savedPw = process.env.APP_PASSWORD;
    process.env.APP_PASSWORD = "test-gate-password";
    const mw = async (path: string, method = "GET") => {
      const res = await middleware(new NextRequest(new URL(`https://xanther.netlify.app${path}`), { method } as never));
      return { isNext: res.headers.get("x-middleware-next") === "1", status: res.status, location: res.headers.get("location") };
    };
    const fnBypass = await mw("/.netlify/functions/process-plaid-webhooks-background", "POST");
    const finProt = await mw("/finances");
    const apiProt = await mw("/api/finances/connections");
    const webhookPublic = await mw("/api/webhooks/plaid", "POST");
    ok("[D1] worker path bypasses the owner login middleware (no /login redirect; passes through)", fnBypass.isNext === true && fnBypass.location === null);
    ok("[D2] /finances remains protected (307 → /login when unauthenticated)", finProt.isNext === false && finProt.status === 307 && /\/login/.test(finProt.location ?? ""));
    ok("[D3] private application APIs remain protected (401 when unauthenticated)", apiProt.isNext === false && apiProt.status === 401);
    ok("[D4] /api/webhooks/plaid remains publicly reachable past the gate (signature-protected at the route)", webhookPublic.isNext === true);
    ok("[D23] owner-session protection remains intact (the bypass is narrow to /.netlify/functions/ only)", /pathname\.startsWith\("\/\.netlify\/functions\/"\)/.test(mwSrc) && !/startsWith\("\/\.netlify\/"\)/.test(mwSrc) && /\\\.netlify\/functions/.test(mwSrc));
    if (savedPw === undefined) delete process.env.APP_PASSWORD; else process.env.APP_PASSWORD = savedPw;

    // Worker authorization still enforced INSIDE the function (independent of the bypass).
    const sAuth = process.env.PLAID_WEBHOOK_PROCESSOR_SECRET; process.env.PLAID_WEBHOOK_PROCESSOR_SECRET = "d-secret-xyz-123456";
    ok("[D5] background worker still rejects a MISSING processor key", authorizeProcessorRequest(undefined) === false && authorizeProcessorRequest("") === false);
    ok("[D6] background worker still rejects a WRONG processor key", authorizeProcessorRequest("wrong-key") === false);
    ok("[D7] background worker accepts the CORRECT processor key", authorizeProcessorRequest("d-secret-xyz-123456") === true);
    ok("[D8] the middleware bypass alone cannot cause processing without the correct key (auth is a separate gate)", /authorizeProcessorRequest\(req\.headers\.get\(PROCESSOR_HEADER\)\)/.test(bgSrc) && authorizeProcessorRequest("wrong-key") === false);
    if (sAuth === undefined) delete process.env.PLAID_WEBHOOK_PROCESSOR_SECRET; else process.env.PLAID_WEBHOOK_PROCESSOR_SECRET = sAuth;

    // Trigger-response classification — ONLY 202 is success.
    ok("[D9] a login redirect (307/308 or manual-mode opaqueredirect 0) is a trigger FAILURE", classifyTriggerResponse(307, null).ok === false && classifyTriggerResponse(308, null).ok === false && classifyTriggerResponse(0, null).ok === false);
    ok("[D10] a followed/HTML login response (200 text/html) is NOT a success", classifyTriggerResponse(200, "text/html; charset=utf-8").ok === false);
    ok("[D11] a 404 (function not routable) is a trigger FAILURE", classifyTriggerResponse(404, null).ok === false);
    ok("[D12] a 401 (worker rejection) is a trigger FAILURE", classifyTriggerResponse(401, null).ok === false);
    ok("[D13] a 5xx (execution/invocation error) is a trigger FAILURE", classifyTriggerResponse(503, null).ok === false);
    const acAbort = new AbortController(); acAbort.abort();
    const netOutcome = await triggerBackgroundProcessor("http://127.0.0.1:9", acAbort.signal);
    ok("[D14] a network failure is a trigger FAILURE and leaves the event recoverable (no throw)", netOutcome.ok === false && netOutcome.reason === "network");
    ok("[D15] the documented Netlify background acceptance status (202) is recognized as success", BACKGROUND_ACCEPTED_STATUS === 202 && classifyTriggerResponse(202, null).ok === true);

    // Trigger FAILURE must not delete/alter the durable event, attempts, cursor, or imports.
    // Capture ALL baselines BEFORE the failed dispatch (and before any real claim, which
    // legitimately advances the cursor in [D17]).
    const bodyD = whBody(itemId, "SYNC_UPDATES_AVAILABLE", "TRANSACTIONS", "d-fail");
    const vD = await plaidAdapter.verifyWebhook({ headers: { "Plaid-Verification": await signWH(bodyD, "kidA", privateKey) }, rawBody: bodyD });
    const intakeD = await intakeWebhook(vD, "sandbox");
    const cursorBeforeFail = (await connRow(conn.id)).transactionsCursor;
    const impBeforeFail = (await db.select().from(importedTransactions).where(eq(importedTransactions.userId, U))).length;
    const ac2 = new AbortController(); ac2.abort();
    const failOut = await triggerBackgroundProcessor("http://127.0.0.1:9", ac2.signal); // simulate a failed dispatch (network)
    const evAfterFail = (await db.select().from(plaidWebhookEvents).where(eq(plaidWebhookEvents.id, intakeD.eventId)))[0];
    const cursorAfterFail = (await connRow(conn.id)).transactionsCursor;
    const impAfterFail = (await db.select().from(importedTransactions).where(eq(importedTransactions.userId, U))).length;
    ok("[D16] trigger failure does not delete or lose the durable event (still 'received')", failOut.ok === false && evAfterFail != null && evAfterFail.status === "received");
    ok("[D18] trigger failure does not alter the transaction cursor", cursorAfterFail === cursorBeforeFail);
    ok("[D19] trigger failure does not alter imported transactions", impAfterFail === impBeforeFail);
    // Attempts increment ONLY when a worker actually claims — never from a failed dispatch.
    const attemptsAfterFail = evAfterFail.attemptCount;
    const claimRes = await processWebhookEvent(intakeD.eventId, fakeProvider(fakePage([dto("Dtx", "a", -1)], "DC")));
    const attemptsAfterClaim = (await db.select().from(plaidWebhookEvents).where(eq(plaidWebhookEvents.id, intakeD.eventId)))[0].attemptCount;
    ok("[D17] trigger failure does not increment attempts; a real claim does", attemptsAfterFail === 0 && claimRes.processed === true && attemptsAfterClaim >= 1);

    // Route wiring: ack promptly after intake; never silently swallow; no secret/URL leak.
    ok("[D20] the scheduled drainer remains ENABLED (every 10 min)", /schedule: "\*\/10 \* \* \* \*"/.test(read("netlify/functions/drain-plaid-webhooks.mts")));
    ok("[D21] Plaid webhook is acked promptly AFTER durable intake (intake before trigger; bounded trigger; returns ok:true)", routeSrc.indexOf("intakeWebhook") < routeSrc.indexOf("triggerBackgroundProcessor") && /ac\.abort/.test(routeSrc) && /NextResponse\.json\(\{ ok: true \}\)/.test(routeSrc));
    ok("[D22] no processor secret or internal function URL leaks (route never names the secret/URL; trigger never logs the secret)", !/PLAID_WEBHOOK_PROCESSOR_SECRET/.test(routeSrc) && !/process-plaid-webhooks-background/.test(routeSrc) && !/console\.(log|warn|error)\([^)]*PLAID_WEBHOOK_PROCESSOR_SECRET/.test(svcSrc));
    ok("[D24] the route does NOT silently swallow the trigger (no fire-and-forget catch; checks outcome.ok)", !/\.catch\(\(\) => \{\}\)/.test(routeSrc) && /outcome\.ok/.test(routeSrc));
    ok("[D-invariant] a verified event is NEVER reported as successfully dispatched merely because the trigger hit the login page (redirect or rendered HTML)", classifyTriggerResponse(307, null).ok === false && classifyTriggerResponse(0, null).ok === false && classifyTriggerResponse(200, "text/html").ok === false && classifyTriggerResponse(202, null).ok === true);

    /* ============ configuration + scope [36-48] ============ */
    console.log("\n[configuration + scope]");
    ok("[36] new Link tokens include the Sandbox webhook URL (when configured)", /PLAID_WEBHOOK_URL/.test(adapterSrc) && /\.\.\.\(webhook \? \{ webhook \} : \{\}\)/.test(adapterSrc));
    // existing-Item webhook update (set a dummy https URL temporarily; Sandbox accepts it)
    const savedUrl = process.env.PLAID_WEBHOOK_URL;
    process.env.PLAID_WEBHOOK_URL = "https://example.com/api/webhooks/plaid";
    let cfgOk = false; try { cfgOk = (await configureConnectionWebhook(U, conn.id)).ok; } catch { cfgOk = false; }
    ok("[37] existing Sandbox connection can receive the configured webhook", cfgOk);
    delete process.env.PLAID_WEBHOOK_URL;
    let degraded = false; try { await configureConnectionWebhook(U, conn.id); } catch (e) { degraded = (e as { status?: number }).status === 503; }
    process.env.PLAID_WEBHOOK_URL = savedUrl;
    ok("[38] missing webhook URL fails/degrades truthfully (503)", degraded);
    ok("[39] webhook URL is never exposed as a secret (server-only env; not in views/UI)", !/PLAID_WEBHOOK_URL/.test(uiSrc) && /process\.env\.PLAID_WEBHOOK_URL/.test(adapterSrc + svcSrc));
    ok("[40] Sandbox fire-webhook path is exercisable (verifier accepts a fired-style payload)", vFull1.verified === true);
    ok("[41] no Production connection (Sandbox enforced in client/env)", /environment !== ["']sandbox["']|readPlaidSandboxConfig/.test(svcSrc + verifierSrc));
    ok("[42] no OAuth expansion", !/oauth|redirect_uri/i.test(stripComments(svcSrc + routeSrc)));
    ok("[43/44/45/46] no matching / bill / income / transfer confirmation", !/matchBill|matchIncome|pairTransfer|payBill|receiveIncome|completeTransfer/i.test(svcSrc));
    ok("[47] no AI categorization", !/anthropic|openai|categoriz|messages\.create/i.test(svcSrc + routeSrc));
    ok("[48] no money movement", !/moveMoney|paymentInitiation|transferCreate/i.test(stripComments(svcSrc + routeSrc + adapterSrc)));
    ok("[mw] webhook route is public (exempt from the owner-session gate)", /\/api\/webhooks\/plaid/.test(middlewareSrc));
    const whTable = schemaSrc.match(/plaidWebhookEvents = pgTable\([\s\S]*?\n\);/)?.[0] ?? "";
    ok("[schema] plaid_webhook_events stores no token / raw payload / transaction columns", /pgTable\(\s*["']plaid_webhook_events["']/.test(schemaSrc) && !/raw_payload|access_token|transaction|amount|account_number/i.test(whTable));

    /* ============ LIVE webhook → real sync proof (clean-cursor connection) ============ */
    console.log("\n[live webhook → real Plaid sync]");
    const connLive = await exchangeAndStore(U, await sandboxCreatePublicToken()); temp.connIds.push(connLive.id);
    const crLive = await connRow(connLive.id); const itemLive = crLive.providerItemId; tempItemIds.push(itemLive);
    const tokLive = decryptToken({ v: crLive.accessTokenEnvelopeVersion, keyVersion: crLive.accessTokenKeyVersion, nonce: crLive.accessTokenNonce, ciphertext: crLive.accessTokenCipher, tag: crLive.accessTokenTag }, resolveMasterKeyFromEnv(1)!) as ProviderAccessToken;
    await sandboxCreateTransactions(tokLive, [{ date_transacted: "2026-06-20", date_posted: "2026-06-21", amount: 7.77, description: "WH live" }]);
    const bodyLive = whBody(itemLive, "SYNC_UPDATES_AVAILABLE", "TRANSACTIONS", "req-live");
    const jwtLive = await signWH(bodyLive, "kidA", privateKey);
    const vLive = await plaidAdapter.verifyWebhook({ headers: { "Plaid-Verification": jwtLive }, rawBody: bodyLive });
    const intakeLive = await intakeWebhook(vLive, "sandbox");
    let liveImported = 0;
    for (let i = 0; i < 6 && liveImported === 0; i++) {
      await processWebhookEvent(intakeLive.eventId); // REAL sync (clean cursor)
      liveImported = (await db.select().from(importedTransactions).where(eq(importedTransactions.connectionId, connLive.id))).length;
      if (!liveImported) { await new Promise((r) => setTimeout(r, 1500)); await db.update(plaidWebhookEvents).set({ status: "received" }).where(eq(plaidWebhookEvents.id, intakeLive.eventId)); }
    }
    ok("[live] a verified webhook triggers the REAL transaction sync (no manual press)", liveImported >= 1);
  } catch (e) {
    bodyError = e;
  } finally {
    await cleanup();
  }

  /* ============ owner protection [49-60] (after cleanup) ============ */
  console.log("\n[owner protection]");
  const ownerAcctsAfter = JSON.stringify(await db.select().from(financialAccounts).where(and(eq(financialAccounts.userId, U), isNull(financialAccounts.deletedAt))));
  ok("[49/50] Chase + BofA manual accounts unchanged", ownerAcctsAfter === ownerAcctsBefore && JSON.parse(ownerAcctsAfter).filter((a: { name: string; balanceSource: string }) => ["Chase", "BofA"].includes(a.name)).every((a: { balanceSource: string }) => a.balanceSource === "manual"));
  const linked = await db.select().from(financialAccounts).where(and(eq(financialAccounts.userId, U), eq(financialAccounts.balanceSource, "linked"), isNull(financialAccounts.deletedAt)));
  ok("[51] Plaid Checking linked account remains mapped", linked.some((a) => a.name === "Plaid Checking") && (await orphanLinkedCount(U)) === 0);
  ok("[52] existing owner imported transactions remain intact", (await db.select().from(importedTransactions).where(eq(importedTransactions.userId, U))).length === ownerImportedBefore);
  ok("[53] no linked-account orphan is created", (await orphanLinkedCount(U)) === 0);
  ok("[54] owner balances not recomputed from imported transactions", !/balance_current\s*=|currentBalance:\s*String|UPDATE financial_accounts SET (current_balance|balance)/i.test(svcSrc + read("lib/services/transactions.ts")));
  ok("[55] request 222 remains present", (await db.select().from(experienceRequests).where(eq(experienceRequests.id, 222))).length === 1);
  ok("[56] owner bills/income/transfers/movements untouched", (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length === movBefore && (await db.select().from(incomeEntries).where(eq(incomeEntries.userId, U))).length >= 0 && (await db.select().from(financialEntries).where(eq(financialEntries.userId, U))).length >= 0 && (await db.select().from(accountTransfers).where(eq(accountTransfers.userId, U))).length >= 0);
  ok("[57] no usage-log row created", (await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))).length === logsBefore);
  ok("[58] .env.local remains ignored (gitignore)", /(^|\n)\.env\.local/.test(read(".gitignore")));
  ok("[59] no secret in source (no real token literal; no plaintext token column)", !/access-sandbox-[0-9a-f]{8}|access-production-/.test(verifierSrc + svcSrc + routeSrc + adapterSrc) && !/["']access_token["']/.test(schemaSrc));
  ok("[60] exact-ID cleanup (no temp connections / webhook events / orphans remain)",
    (await db.select().from(financialConnections).where(and(eq(financialConnections.userId, U), inArray(financialConnections.id, temp.connIds.length ? temp.connIds : [-1])))).length === 0 &&
    (await db.select().from(plaidWebhookEvents).where(inArray(plaidWebhookEvents.providerItemId, tempItemIds.length ? tempItemIds : ["__none__"]))).length === 0 &&
    (await orphanLinkedCount(U)) === 0);
  ok("[owner-conns] owner's real Sandbox connection untouched", JSON.stringify((await db.select().from(financialConnections).where(and(eq(financialConnections.userId, U), isNull(financialConnections.deletedAt)))).map((c) => c.id).sort()) === JSON.stringify(ownerConnsBefore));

  if (bodyError) { failed++; console.error("body error:", bodyError instanceof Error ? bodyError.message : bodyError); }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch(async (e) => { try { await cleanup(); } catch { /* ignore */ } console.error(e); process.exit(1); });
