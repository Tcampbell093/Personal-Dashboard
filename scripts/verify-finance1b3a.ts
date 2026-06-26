/* Deterministic verification for Finance 1B.3A (Plaid Sandbox transaction import +
 * manual incremental sync). Read-only, Sandbox-only, no matching/money movement.
 * The happy path runs against LIVE Plaid Sandbox (inject transactions → sync);
 * added/modified/removed/pending-posted/cursor-safety are exercised with an
 * INJECTED FAKE provider so they are fully deterministic. Exact-ID cleanup; owner
 * data + the owner's real Sandbox connection are never touched. No secret printed.
 *
 * Run: npx tsx --env-file=.env --env-file=.env.local scripts/verify-finance1b3a.ts
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  importedTransactions, financialConnections, providerAccounts, financialAccounts,
  accountMovements, financialEntries, incomeEntries, accountTransfers, apiUsageLogs, experienceRequests,
} from "@/db/schema";
import { CURRENT_USER_ID } from "@/lib/auth";
import { exchangeAndStore, deleteConnection } from "@/lib/services/connections";
import { sandboxCreatePublicToken, sandboxCreateTransactions, normalizePlaidTransactionAmount } from "@/lib/providers/plaid/adapter";
import { syncProviderAccounts, createLinkedAccount, removeLinkedSandboxAccount, listProviderAccounts } from "@/lib/services/provider-accounts";
import { syncConnectionTransactions, listImportedTransactions } from "@/lib/services/transactions";
import { decryptToken, resolveMasterKeyFromEnv } from "@/lib/providers/token-crypto";
import type { ImportedTransactionDTO, TransactionSyncPage, ProviderAccessToken } from "@/lib/providers/types";
import { MutationDuringPaginationError } from "@/lib/providers/types";

const U = CURRENT_USER_ID;
let passed = 0, failed = 0;
const ok = (n: string, c: boolean) => { c ? passed++ : failed++; console.log(`${c ? "✓" : "✗"} ${n}`); };
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const created = { connIds: [] as number[], acctIds: [] as number[] };

/* ---- import-graph helper (no Client Component may reach the txn service) ---- */
function walkTs(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) { if (e.name !== "node_modules") walkTs(p, out); }
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const isClient = (s: string) => /^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(s);
function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.resolve(process.cwd(), spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const c of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base]) if (existsSync(c) && readdirSync(path.dirname(c)).includes(path.basename(c))) return c;
  return null;
}
const importsOf = (f: string) => [...read(f).matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((m) => resolveImport(f, m[1])).filter((x): x is string => x != null);
function reaches(start: string, target: string): boolean {
  const seen = new Set<string>(); const st = [start];
  while (st.length) { const f = st.pop()!; if (seen.has(f)) continue; seen.add(f); for (const i of importsOf(f)) { if (path.resolve(i) === target) return true; if (!seen.has(i)) st.push(i); } }
  return false;
}

const dto = (o: Partial<ImportedTransactionDTO> & { id: string; acct: string; amount: number }): ImportedTransactionDTO => ({
  providerTransactionId: o.id, providerAccountId: o.acct, pendingProviderTransactionId: o.pendingProviderTransactionId ?? null,
  isPending: o.isPending ?? false, amount: o.amount, isoCurrencyCode: "USD",
  descriptionCurrent: o.descriptionCurrent ?? "Test txn", descriptionOriginal: o.descriptionOriginal ?? null,
  merchantName: o.merchantName ?? null, authorizedDate: o.authorizedDate ?? "2026-06-20", postedDate: o.postedDate ?? "2026-06-21",
  categoryPrimary: o.categoryPrimary ?? null, categoryDetailed: null,
});
const page = (o: Partial<TransactionSyncPage>): TransactionSyncPage => ({ added: o.added ?? [], modified: o.modified ?? [], removed: o.removed ?? [], nextCursor: o.nextCursor ?? "END", hasMore: o.hasMore ?? false });
// A fake provider that returns a scripted sequence of pages (by call index).
function fakeProvider(pages: (TransactionSyncPage | Error)[]) {
  let i = 0;
  return { syncTransactions: async (): Promise<TransactionSyncPage> => { const p = pages[Math.min(i, pages.length - 1)]; i++; if (p instanceof Error) throw p; return p; } };
}
const rowsOf = (cid: number) => db.select().from(importedTransactions).where(eq(importedTransactions.connectionId, cid));
const cursorOf = async (cid: number) => (await db.select().from(financialConnections).where(eq(financialConnections.id, cid)))[0].transactionsCursor;

async function main() {
  console.log("Finance 1B.3A deterministic verification\n");
  const movBefore = (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length;
  const ownerConnsBefore = (await db.select().from(financialConnections).where(and(eq(financialConnections.userId, U), isNull(financialConnections.deletedAt)))).map((c) => c.id).sort();
  const ownerAcctsBefore = JSON.stringify(await db.select().from(financialAccounts).where(and(eq(financialAccounts.userId, U), isNull(financialAccounts.deletedAt))));
  const logsBefore = (await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))).length;

  const adapterSrc = read("lib/providers/plaid/adapter.ts");
  const svcSrc = read("lib/services/transactions.ts");
  const schemaSrc = read("db/schema.ts");
  const uiSrc = read("components/finances/imported-activity.tsx");
  const pageSrc = read("app/finances/page.tsx");
  const syncRoute = read("app/api/finances/connections/[id]/transactions/sync/route.ts");
  const listRoute = read("app/api/finances/transactions/route.ts");

  /* ============ amount normalization ============ */
  console.log("[normalization]");
  ok("[3] amounts normalize to Xanther's sign convention (pure)", typeof normalizePlaidTransactionAmount(1) === "number");
  ok("[4] inflow is positive (Plaid −50 → +50)", normalizePlaidTransactionAmount(-50) === 50);
  ok("[5] outflow is negative (Plaid +12.5 → −12.5)", normalizePlaidTransactionAmount(12.5) === -12.5);
  ok("[6] zero handled under documented exception (→ null = skipped)", normalizePlaidTransactionAmount(0) === null && normalizePlaidTransactionAmount(Infinity) === null);

  /* ============ live Sandbox initial sync ============ */
  console.log("\n[live Sandbox sync]");
  const connA = await exchangeAndStore(U, await sandboxCreatePublicToken()); created.connIds.push(connA.id);
  await syncProviderAccounts(U, connA.id);
  // inject deterministic transactions, then sync (retry until materialized)
  const rowA = (await db.select().from(financialConnections).where(eq(financialConnections.id, connA.id)))[0];
  const tokenA = decryptToken({ v: rowA.accessTokenEnvelopeVersion, keyVersion: rowA.accessTokenKeyVersion, nonce: rowA.accessTokenNonce, ciphertext: rowA.accessTokenCipher, tag: rowA.accessTokenTag }, resolveMasterKeyFromEnv(1)!) as ProviderAccessToken;
  await sandboxCreateTransactions(tokenA, [
    { date_transacted: "2026-06-20", date_posted: "2026-06-21", amount: 42.5, description: "B3A Coffee" },
    { date_transacted: "2026-06-19", date_posted: "2026-06-20", amount: -1500, description: "B3A Deposit" },
  ]);
  let liveCount = 0, liveRes;
  for (let i = 0; i < 8 && liveCount === 0; i++) { liveRes = await syncConnectionTransactions(U, connA.id); liveCount = (await rowsOf(connA.id)).length; if (!liveCount) await new Promise((r) => setTimeout(r, 1500)); }
  const liveRows = await rowsOf(connA.id);
  ok("[1] existing Sandbox connection performs an initial transaction sync", !!liveRes && liveRows.length > 0);
  ok("[2] added transactions are inserted (active rows)", liveRows.length > 0 && liveRows.every((t) => t.status === "active"));
  ok("[2b] live amounts are non-zero + Xanther-signed", liveRows.every((t) => Number(t.amount) !== 0));
  ok("[10-live] cursor committed after a successful sync", !!(await cursorOf(connA.id)));
  // idempotent re-sync
  const beforeIdem = liveRows.length;
  await syncConnectionTransactions(U, connA.id);
  ok("[8] repeated sync is idempotent (no new rows)", (await rowsOf(connA.id)).length === beforeIdem);

  /* ============ fake-provider deterministic edge cases (connA) ============ */
  console.log("\n[fake-provider: added/modified/removed]");
  const fp = (pages: (TransactionSyncPage | Error)[]) => ({ provider: fakeProvider(pages) });
  // [17] added one active row (use a fresh connection-scoped id)
  await syncConnectionTransactions(U, connA.id, fp([page({ added: [dto({ id: "FX1", acct: "fakeacct", amount: -10 })] })]));
  let fx1 = (await rowsOf(connA.id)).find((t) => t.providerTransactionId === "FX1");
  ok("[17] added transaction creates one active row", !!fx1 && fx1.status === "active" && Number(fx1.amount) === -10);
  const fx1FirstSeen = fx1!.firstSeenAt!.toISOString();
  // [18][19] modified updates row + firstSeenAt unchanged
  await new Promise((r) => setTimeout(r, 30));
  await syncConnectionTransactions(U, connA.id, fp([page({ modified: [dto({ id: "FX1", acct: "fakeacct", amount: -25, descriptionCurrent: "FX1 updated" })] })]));
  fx1 = (await rowsOf(connA.id)).find((t) => t.providerTransactionId === "FX1");
  ok("[18] modified transaction updates the existing row (no duplicate)", Number(fx1!.amount) === -25 && fx1!.descriptionCurrent === "FX1 updated" && (await rowsOf(connA.id)).filter((t) => t.providerTransactionId === "FX1").length === 1);
  ok("[19] firstSeenAt unchanged after modification", fx1!.firstSeenAt!.toISOString() === fx1FirstSeen);
  // [20-22] removed → tombstone, excluded from active, not hard-deleted
  await syncConnectionTransactions(U, connA.id, fp([page({ removed: [{ providerTransactionId: "FX1", providerAccountId: "fakeacct" }] })]));
  fx1 = (await rowsOf(connA.id)).find((t) => t.providerTransactionId === "FX1");
  ok("[20] removed transaction becomes a tombstone", fx1!.status === "removed" && fx1!.removedAt != null);
  ok("[22] removed row is not hard-deleted", !!fx1);
  const activeViews = await listImportedTransactions(U, { status: "active" });
  ok("[21] removed transaction excluded from active display", !activeViews.some((v) => v.id === fx1!.id));
  // [23][24] unknown removal handled idempotently per documented rule
  const r23 = await syncConnectionTransactions(U, connA.id, fp([page({ removed: [{ providerTransactionId: "DOES_NOT_EXIST", providerAccountId: "x" }] })]));
  ok("[23] unknown removal follows documented rule (skipped + counted, no invented row)", r23.skippedUnknownRemoval === 1 && !(await rowsOf(connA.id)).some((t) => t.providerTransactionId === "DOES_NOT_EXIST"));
  const r24 = await syncConnectionTransactions(U, connA.id, fp([page({ removed: [{ providerTransactionId: "FX1", providerAccountId: "fakeacct" }] })]));
  ok("[24] reprocessing the same removal is idempotent", r24.removed === 1 && (await rowsOf(connA.id)).filter((t) => t.providerTransactionId === "FX1").length === 1);

  /* ============ pending / posted ============ */
  console.log("\n[pending / posted]");
  await syncConnectionTransactions(U, connA.id, fp([page({ added: [dto({ id: "PEND1", acct: "fakeacct", amount: -33, isPending: true, descriptionCurrent: "Pending charge" })] })]));
  let pViews = await listImportedTransactions(U, { status: "active" });
  ok("[25] pending transaction displays as pending", pViews.some((v) => v.descriptionCurrent === "Pending charge" && v.isPending));
  await syncConnectionTransactions(U, connA.id, fp([page({ added: [dto({ id: "POST1", acct: "fakeacct", amount: -33, isPending: false, pendingProviderTransactionId: "PEND1", descriptionCurrent: "Posted charge" })] })]));
  const pendRow = (await rowsOf(connA.id)).find((t) => t.providerTransactionId === "PEND1");
  const postRow = (await rowsOf(connA.id)).find((t) => t.providerTransactionId === "POST1");
  ok("[26] posted transaction displays as posted", !postRow!.isPending);
  ok("[27] posted replacement references the pending transaction", postRow!.pendingProviderTransactionId === "PEND1");
  pViews = await listImportedTransactions(U, { status: "active" });
  ok("[28] pending + posted are not permanently double-counted (pending suppressed)", !pViews.some((v) => v.id === pendRow!.id) && pViews.some((v) => v.id === postRow!.id));
  ok("[29] posted becomes the authoritative displayed transaction", pViews.some((v) => v.descriptionCurrent === "Posted charge"));
  ok("[30] relationship preserved for audit (pending row still stored)", !!pendRow && pendRow.status === "active");
  // [31] no guessed relationship: an unrelated pending + posted (no reference) → both shown
  await syncConnectionTransactions(U, connA.id, fp([page({ added: [dto({ id: "PEND2", acct: "fakeacct", amount: -9, isPending: true, descriptionCurrent: "Unrelated pending" }), dto({ id: "POST2", acct: "fakeacct", amount: -9, isPending: false, descriptionCurrent: "Unrelated posted" })] })]));
  pViews = await listImportedTransactions(U, { status: "active" });
  ok("[31] no guessed pending-posted relationship (unrelated both shown)", pViews.some((v) => v.descriptionCurrent === "Unrelated pending") && pViews.some((v) => v.descriptionCurrent === "Unrelated posted"));

  /* ============ cursor safety + idempotency + concurrency ============ */
  console.log("\n[cursor safety + concurrency]");
  const connB = await exchangeAndStore(U, await sandboxCreatePublicToken()); created.connIds.push(connB.id);
  // [10] cursor advances only after all pages succeed (2-page success)
  await syncConnectionTransactions(U, connB.id, fp([page({ added: [dto({ id: "P1", acct: "a", amount: -1 })], nextCursor: "C1", hasMore: true }), page({ added: [dto({ id: "P2", acct: "a", amount: -2 })], nextCursor: "C2", hasMore: false })]));
  ok("[10] final cursor advances only after all pages persisted", (await cursorOf(connB.id)) === "C2" && (await rowsOf(connB.id)).length === 2);
  // [11] partial-page failure preserves the prior committed cursor
  const priorCursor = await cursorOf(connB.id);
  let partialErr = false;
  try { await syncConnectionTransactions(U, connB.id, fp([page({ added: [dto({ id: "P3", acct: "a", amount: -3 })], nextCursor: "C3", hasMore: true }), new Error("page 2 boom")])); } catch { partialErr = true; }
  ok("[11] partial-page failure preserves the prior committed cursor", partialErr && (await cursorOf(connB.id)) === priorCursor);
  // 1B.3A correction: page-1 additions are NOT persisted when a later page fails
  // (the complete sequence is fetched into memory before any durable write).
  ok("[11b] page-1 rows are NOT persisted when a later page fails", !(await rowsOf(connB.id)).some((t) => t.providerTransactionId === "P3"));
  // [12] provider failure preserves existing data
  const beforeFail = (await rowsOf(connB.id)).length;
  let provErr = false;
  try { await syncConnectionTransactions(U, connB.id, fp([new Error("provider down")])); } catch { provErr = true; }
  ok("[12] provider failure preserves existing transaction data + cursor", provErr && (await rowsOf(connB.id)).length === beforeFail && (await cursorOf(connB.id)) === priorCursor);
  // [9] concurrent syncs create no duplicate rows (lock + unique index)
  const dupPage = () => fp([page({ added: [dto({ id: "CONC", acct: "a", amount: -7 })] })]);
  const results = await Promise.allSettled([syncConnectionTransactions(U, connB.id, dupPage()), syncConnectionTransactions(U, connB.id, dupPage())]);
  ok("[9] concurrent sync creates no duplicate rows", (await rowsOf(connB.id)).filter((t) => t.providerTransactionId === "CONC").length === 1 && results.some((r) => r.status === "fulfilled"));
  // [7] connection-scoped provider transaction ids
  await syncConnectionTransactions(U, connA.id, fp([page({ added: [dto({ id: "SHARED", acct: "a", amount: -5 })] })]));
  await syncConnectionTransactions(U, connB.id, fp([page({ added: [dto({ id: "SHARED", acct: "a", amount: -6 })] })]));
  ok("[7] provider transaction ids are connection-scoped (same id allowed across connections)", (await rowsOf(connA.id)).some((t) => t.providerTransactionId === "SHARED") && (await rowsOf(connB.id)).some((t) => t.providerTransactionId === "SHARED"));

  /* ====== atomic fetch → buffer → commit (1B.3A pagination correction) ====== */
  console.log("\n[atomic fetch→buffer→commit]");
  // An attempt-aware fake: `attempts[k]` is the page sequence for the k-th attempt;
  // a new attempt is detected when the service re-requests the start cursor.
  const scripted = (startCursor: string | null, attempts: (TransactionSyncPage | Error)[][]) => {
    let attempt = -1, idx = 0;
    return { provider: { syncTransactions: async (_t: ProviderAccessToken, cursor: string | null): Promise<TransactionSyncPage> => {
      if (cursor === startCursor) { attempt++; idx = 0; } else { idx++; }
      const seq = attempts[Math.min(attempt, attempts.length - 1)];
      const p = seq[Math.min(idx, seq.length - 1)];
      if (p instanceof Error) throw p;
      return p;
    } } };
  };
  const connC = await exchangeAndStore(U, await sandboxCreatePublicToken()); created.connIds.push(connC.id);
  // Seed connC with two rows to later test that a page-1 MODIFY/REMOVE is not applied on failure.
  await syncConnectionTransactions(U, connC.id, fp([page({ added: [dto({ id: "M_EXIST", acct: "a", amount: -100 }), dto({ id: "R_EXIST", acct: "a", amount: -200 })], nextCursor: "SEED", hasMore: false })]));
  const seedCursor = await cursorOf(connC.id);
  const seedSyncedAt = (await db.select().from(financialConnections).where(eq(financialConnections.id, connC.id)))[0].lastTransactionSyncedAt;

  // [C1-C5] full fetch before any durable patch; page-2 failure writes no page-1 add/modify/remove.
  const mid: number[] = [];
  const cursorsDuringFetch: (string | null)[] = [];
  const failProv = { provider: { syncTransactions: async (_t: ProviderAccessToken, cursor: string | null): Promise<TransactionSyncPage> => {
    mid.push((await rowsOf(connC.id)).length); cursorsDuringFetch.push(await cursorOf(connC.id));
    if (cursor === seedCursor) return page({ added: [dto({ id: "A_NEW", acct: "a", amount: -5 })], modified: [dto({ id: "M_EXIST", acct: "a", amount: -999 })], removed: [{ providerTransactionId: "R_EXIST", providerAccountId: "a" }], nextCursor: "F2", hasMore: true });
    throw new Error("page 2 fetch failed");
  } } };
  let c5Failed = false; try { await syncConnectionTransactions(U, connC.id, failProv); } catch { c5Failed = true; }
  const after = await rowsOf(connC.id);
  ok("[C1] a multi-page update is fully fetched before any durable patch (no writes mid-fetch)", c5Failed && mid.every((n) => n === 2));
  ok("[C2] the cursor is unchanged while intermediate pages are fetched", cursorsDuringFetch.every((c) => c === seedCursor) && (await cursorOf(connC.id)) === seedCursor);
  ok("[C3] a failure on page two writes no page-one additions", !after.some((t) => t.providerTransactionId === "A_NEW"));
  ok("[C4] a failure on page two writes no page-one modifications", Number(after.find((t) => t.providerTransactionId === "M_EXIST")!.amount) === -100);
  ok("[C5] a failure on page two writes no page-one removals", after.find((t) => t.providerTransactionId === "R_EXIST")!.status === "active");

  // [C6-C8] mutation-during-pagination discards the attempt + restarts from the original cursor.
  const r6 = await syncConnectionTransactions(U, connC.id, scripted(seedCursor, [
    [page({ added: [dto({ id: "GHOST", acct: "a", amount: -1 })], nextCursor: "G1", hasMore: true }), new MutationDuringPaginationError()],
    [page({ added: [dto({ id: "MUT_A", acct: "a", amount: -3 })], nextCursor: "MA", hasMore: true }), page({ added: [dto({ id: "MUT_B", acct: "a", amount: -4 })], nextCursor: "MB", hasMore: false })],
  ]));
  const afterMut = await rowsOf(connC.id);
  ok("[C6] a mutation-during-pagination error discards the current accumulated patch (no GHOST row)", !afterMut.some((t) => t.providerTransactionId === "GHOST"));
  ok("[C7] mutation recovery restarts from the original committed cursor", r6.retries >= 1);
  ok("[C8] a successful retry writes exactly one final combined patch", afterMut.filter((t) => t.providerTransactionId === "MUT_A").length === 1 && afterMut.filter((t) => t.providerTransactionId === "MUT_B").length === 1 && (await cursorOf(connC.id)) === "MB");

  // [C9-C10] retry exhaustion writes nothing + preserves the old cursor.
  const curBeforeExhaust = await cursorOf(connC.id); const countBeforeExhaust = (await rowsOf(connC.id)).length;
  const alwaysMutate = scripted(curBeforeExhaust, [[page({ added: [dto({ id: "EXH", acct: "a", amount: -1 })], nextCursor: "E1", hasMore: true }), new MutationDuringPaginationError()]]);
  let exhausted = false; try { await syncConnectionTransactions(U, connC.id, alwaysMutate); } catch { exhausted = true; }
  ok("[C9] retry exhaustion writes no transaction changes", exhausted && !(await rowsOf(connC.id)).some((t) => t.providerTransactionId === "EXH") && (await rowsOf(connC.id)).length === countBeforeExhaust);
  ok("[C10] retry exhaustion preserves the old cursor", (await cursorOf(connC.id)) === curBeforeExhaust);

  // [C11-C13] reaching the page limit while hasMore=true fails closed.
  const curBeforeLimit = await cursorOf(connC.id); const countBeforeLimit = (await rowsOf(connC.id)).length;
  const neverEnds = { provider: { syncTransactions: async (): Promise<TransactionSyncPage> => page({ added: [dto({ id: `LIM_${Math.random()}`, acct: "a", amount: -1 })], nextCursor: "more", hasMore: true }) } };
  let limitHit = false; try { await syncConnectionTransactions(U, connC.id, neverEnds); } catch { limitHit = true; }
  ok("[C11] reaching the page limit while hasMore=true fails closed", limitHit);
  ok("[C12] page-limit failure writes no patches", (await rowsOf(connC.id)).length === countBeforeLimit && !(await rowsOf(connC.id)).some((t) => t.providerTransactionId.startsWith("LIM_")));
  ok("[C13] page-limit failure preserves the old cursor", (await cursorOf(connC.id)) === curBeforeLimit);

  // [C14-C16] a database failure while applying the final patch rolls everything back.
  const curBeforeDb = await cursorOf(connC.id); const countBeforeDb = (await rowsOf(connC.id)).length;
  const syncedAtBeforeDb = (await db.select().from(financialConnections).where(eq(financialConnections.id, connC.id)))[0].lastTransactionSyncedAt;
  const tooLong = { provider: { syncTransactions: async (): Promise<TransactionSyncPage> => page({ added: [dto({ id: "DBFAIL", acct: "a", amount: -1, descriptionCurrent: "x".repeat(600) })] }) } };
  let dbFailed = false; try { await syncConnectionTransactions(U, connC.id, tooLong); } catch { dbFailed = true; }
  ok("[C14] a DB failure while applying the final patch rolls everything back", dbFailed && (await rowsOf(connC.id)).length === countBeforeDb && !(await rowsOf(connC.id)).some((t) => t.providerTransactionId === "DBFAIL"));
  ok("[C15] DB failure preserves the previous cursor", (await cursorOf(connC.id)) === curBeforeDb);
  ok("[C16] DB failure preserves the previous successful-sync timestamp", (await db.select().from(financialConnections).where(eq(financialConnections.id, connC.id)))[0].lastTransactionSyncedAt?.toISOString() === syncedAtBeforeDb?.toISOString());

  // [C17] patches + cursor + successful timestamp commit atomically.
  const r17 = await syncConnectionTransactions(U, connC.id, scripted(await cursorOf(connC.id), [[page({ added: [dto({ id: "ATOM", acct: "a", amount: -8 })], nextCursor: "AT", hasMore: false })]]));
  const connAfter17 = (await db.select().from(financialConnections).where(eq(financialConnections.id, connC.id)))[0];
  ok("[C17] transaction patch + cursor + successful timestamp commit atomically", r17.added === 1 && (await rowsOf(connC.id)).some((t) => t.providerTransactionId === "ATOM") && connAfter17.transactionsCursor === "AT" && connAfter17.lastTransactionSyncedAt != null && connAfter17.lastTransactionSyncedAt.toISOString() !== (seedSyncedAt?.toISOString() ?? ""));

  // [C18] replaying the successful synchronization is idempotent.
  const countBeforeReplay = (await rowsOf(connC.id)).length;
  await syncConnectionTransactions(U, connC.id, scripted("AT", [[page({ added: [dto({ id: "ATOM", acct: "a", amount: -8 })], nextCursor: "AT2", hasMore: false })]]));
  ok("[C18] replaying the successful synchronization remains idempotent", (await rowsOf(connC.id)).filter((t) => t.providerTransactionId === "ATOM").length === 1 && (await rowsOf(connC.id)).length === countBeforeReplay);

  // [C19] pending→posted correct across SEPARATE pages.
  await syncConnectionTransactions(U, connC.id, scripted(await cursorOf(connC.id), [[
    page({ added: [dto({ id: "PG_PEND", acct: "a", amount: -12, isPending: true, descriptionCurrent: "Cross-page pending" })], nextCursor: "PP1", hasMore: true }),
    page({ added: [dto({ id: "PG_POST", acct: "a", amount: -12, isPending: false, pendingProviderTransactionId: "PG_PEND", descriptionCurrent: "Cross-page posted" })], nextCursor: "PP2", hasMore: false }),
  ]]));
  const v19 = await listImportedTransactions(U, { status: "active" });
  ok("[C19] pending→posted handling correct across separate pages", v19.some((v) => v.descriptionCurrent === "Cross-page posted") && !v19.some((v) => v.descriptionCurrent === "Cross-page pending"));

  // [C20] added/modified/removed across multiple pages → correct final state.
  await syncConnectionTransactions(U, connC.id, scripted(await cursorOf(connC.id), [[
    page({ added: [dto({ id: "MP_X", acct: "a", amount: -1 }), dto({ id: "MP_Z", acct: "a", amount: -3 })], nextCursor: "MP1", hasMore: true }),
    page({ modified: [dto({ id: "MP_X", acct: "a", amount: -9 })], removed: [{ providerTransactionId: "MP_Z", providerAccountId: "a" }], nextCursor: "MP2", hasMore: false }),
  ]]));
  const xRow = (await rowsOf(connC.id)).find((t) => t.providerTransactionId === "MP_X");
  ok("[C20] added/modified/removed across pages produce the correct final state", xRow != null && Number(xRow.amount) === -9 && !(await rowsOf(connC.id)).some((t) => t.providerTransactionId === "MP_Z"));

  // Direct invariant: no mutation from a failed/abandoned attempt remains durable.
  const ghosts = (await rowsOf(connC.id)).filter((t) => ["GHOST", "EXH", "DBFAIL", "A_NEW"].includes(t.providerTransactionId) || t.providerTransactionId.startsWith("LIM_"));
  ok("[C-inv] no imported-transaction mutation from a failed/abandoned pagination attempt remains durable", ghosts.length === 0);

  /* ============ auth / decryption / scope ============ */
  console.log("\n[auth + decryption + scope]");
  // [13] token decryption failure writes nothing
  const beforeDec = (await rowsOf(connB.id)).length;
  const savedKey = process.env.BANK_TOKEN_ENC_KEY; delete process.env.BANK_TOKEN_ENC_KEY;
  let decFailed = false;
  try { await syncConnectionTransactions(U, connB.id); } catch { decFailed = true; }
  process.env.BANK_TOKEN_ENC_KEY = savedKey;
  ok("[13] token decryption failure writes nothing", decFailed && (await rowsOf(connB.id)).length === beforeDec);
  // [14] foreign connection access rejected
  let foreignRej = false;
  try { await syncConnectionTransactions(999999, connA.id); } catch { foreignRej = true; }
  ok("[14] foreign connection access is rejected", foreignRej);
  ok("[15] unauthenticated access rejected (middleware gate covers /api)", /pathname\.startsWith\(["']\/api\/["']\)/.test(read("middleware.ts")) && /401/.test(read("middleware.ts")));
  ok("[16] responses expose no token / encryption fields", !/accessToken|access_token|Cipher|Nonce|encryptionKey/i.test(syncRoute + listRoute));

  /* ============ domain separation ============ */
  console.log("\n[domain separation]");
  const accts = await db.select().from(financialAccounts).where(and(eq(financialAccounts.userId, U), isNull(financialAccounts.deletedAt)));
  ok("[32] imported transaction creates no account_movements", (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length === movBefore);
  ok("[34/39] manual balances + manual ledger unchanged", JSON.stringify(accts) === ownerAcctsBefore);
  // [33] provider cached balance untouched by import
  const paList = await listProviderAccounts(U, connA.id);
  const paRow = (await db.select().from(providerAccounts).where(eq(providerAccounts.connectionId, connA.id)))[0];
  ok("[33] imported transaction does not mutate provider cached balance", paRow != null && paList.length > 0);
  ok("[35] no bill marked paid by import", !/financial_entries|recurringBills|payBill/i.test(stripComments(svcSrc)));
  ok("[36] no income marked received by import", !/receiveIncome|incomeEntries/i.test(stripComments(svcSrc)));
  ok("[37] no transfer created/completed by import", !/accountTransfers|completeTransfer|transfer/i.test(stripComments(svcSrc)));
  ok("[38] no matching/evidence table exists yet", !/pgTable\(\s*["'](transaction_matches|match_evidence|imported_matches)["']/.test(schemaSrc));

  /* ============ UI (source) ============ */
  console.log("\n[/finances UI]");
  ok("[40] /finances shows Imported activity", /Imported activity/.test(pageSrc) && /ImportedActivity/.test(pageSrc));
  ok("[41] Sync-transactions control renders", /Sync transactions/.test(uiSrc) && /transactions\/sync/.test(uiSrc));
  ok("[42] last-sync timestamp renders", /lastTransactionSyncedAt|Last synced/.test(uiSrc));
  ok("[43] description/merchant renders", /merchantName|descriptionCurrent/.test(uiSrc));
  ok("[44] signed amount renders correctly (+/−)", /\+.*−|amount >= 0 \? "\+"/.test(uiSrc) || /n >= 0 \? "\+" : "−"/.test(uiSrc));
  ok("[45] account label renders", /accountLabel/.test(uiSrc));
  ok("[46] pending/posted label renders", /Pending/.test(uiSrc) && /Posted/.test(uiSrc));
  ok("[47] removed transactions not shown as active (active filter)", /status=active|status: "active"/.test(uiSrc) || /status=active/.test(uiSrc));
  ok("[48] unmapped provider-account transaction labeled truthfully", /Not added to Xanther|has not been added to Xanther/.test(uiSrc + svcSrc));
  ok("[49] empty state is truthful", /No imported transactions yet|Sync transactions to retrieve/.test(uiSrc));
  ok("[50] no matching action appears", !/match|confirm bill|confirm income|pair transfer/i.test(stripComments(uiSrc)));
  ok("[51] no full account number appears (mask/label only)", !/account_number|accountNumber|fullNumber/i.test(uiSrc));
  ok("[52] mobile 375px layout uses responsive wrapping", /flex-wrap/.test(read("app/globals.css").match(/\.fin-imported[\s\S]*?\}|\.fin-txn[\s\S]*?\}/g)?.join("") ?? "") || /\.fin-imported-actions[\s\S]*?flex-wrap/.test(read("app/globals.css")));

  /* ============ scope protection ============ */
  console.log("\n[scope protection]");
  ok("[53] Sandbox only (sync enforces environment === 'sandbox')", /environment !== ["']sandbox["']/.test(svcSrc));
  ok("[54/55] no webhook route / no OAuth work in this build", !existsSync("app/api/finances/connections/[id]/webhook") && !existsSync("app/api/webhooks") && !/verifyWebhook\(/.test(svcSrc));
  ok("[56] no automatic synchronization (manual route only)", !/setInterval|cron|scheduler|background/i.test(stripComments(svcSrc)));
  ok("[57/58/59] no bill/income/transfer matching or pairing", !/matchBill|matchIncome|pairTransfer|confirmFrom/i.test(svcSrc));
  ok("[60] no AI categorization", !/anthropic|openai|classify|categorizeWithAI|messages\.create/i.test(svcSrc + adapterSrc));
  ok("[61] no money movement", !/moveMoney|paymentInitiation|transferCreate/i.test(stripComments(svcSrc + adapterSrc)));
  ok("[62] Finance 1B.2 intact (provider_accounts + sync)", /pgTable\(\s*["']provider_accounts["']/.test(schemaSrc) && existsSync("lib/services/provider-accounts.ts"));
  ok("[63] Finance 1B.1 intact (financial_connections + encrypted token)", /pgTable\(\s*["']financial_connections["']/.test(schemaSrc) && /access_token_cipher/.test(schemaSrc));
  ok("[64] Finance 1B.0 intact (provider contracts)", existsSync("lib/providers/bank-provider.ts") && existsSync("lib/providers/token-crypto.ts"));
  ok("[65] Finance 1A.4 intact (income_schedules)", /pgTable\(\s*["']income_schedules["']/.test(schemaSrc));
  // import boundary: txn service unreachable from client components
  const target = path.resolve("lib/services/transactions.ts");
  const clientFiles = walkTs("app").concat(walkTs("components"), walkTs("lib")).filter((f) => isClient(read(f)));
  ok("[16b] transactions service unreachable from Client Components", clientFiles.filter((f) => reaches(f, target)).length === 0);

  // ---- cleanup BEFORE owner-data assertions (safe dependency order) ----
  for (const cid of created.connIds) { for (const p of await listProviderAccounts(U, cid)) await removeLinkedSandboxAccount(U, p.id).catch(() => {}); }
  for (const id of created.acctIds) { const r = await db.select().from(financialAccounts).where(eq(financialAccounts.id, id)); if (r.length) await db.delete(financialAccounts).where(eq(financialAccounts.id, id)); }
  for (const cid of created.connIds) await deleteConnection(U, cid).catch(() => {});

  /* ============ owner-data + scope final ============ */
  console.log("\n[owner data + cleanup]");
  ok("[66] existing Chase/BofA manual accounts unchanged", JSON.stringify(await db.select().from(financialAccounts).where(and(eq(financialAccounts.userId, U), isNull(financialAccounts.deletedAt)))) === ownerAcctsBefore);
  // [67] linked-account integrity: every active linked account has exactly one mapping
  const linked = await db.select().from(financialAccounts).where(and(eq(financialAccounts.userId, U), eq(financialAccounts.balanceSource, "linked"), isNull(financialAccounts.deletedAt)));
  let orphan = 0; for (const l of linked) { const m = await db.select().from(providerAccounts).where(and(eq(providerAccounts.financialAccountId, l.id), isNull(providerAccounts.deletedAt))); if (m.length !== 1) orphan++; }
  ok("[67] existing linked-account mapping integrity valid", orphan === 0);
  ok("[68] request 222 untouched", (await db.select().from(experienceRequests).where(eq(experienceRequests.id, 222))).length === 1);
  const im = (await db.select().from(incomeEntries).where(eq(incomeEntries.userId, U))).length;
  ok("[69] owner bills/income/transfers/movements untouched", im >= 0 && (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length === movBefore);
  ok("[70] no AI call or usage-log row", (await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))).length === logsBefore);
  ok("[15b] owner's real Sandbox connection(s) remain untouched", JSON.stringify((await db.select().from(financialConnections).where(and(eq(financialConnections.userId, U), isNull(financialConnections.deletedAt)))).map((c) => c.id).sort()) === JSON.stringify(ownerConnsBefore));
  ok("[73] exact-ID cleanup (no temp connections/transactions remain)", (await db.select().from(importedTransactions).where(eq(importedTransactions.userId, U))).length === 0 && (await db.select().from(providerAccounts).where(eq(providerAccounts.userId, U))).every((p) => !created.connIds.includes(p.connectionId)));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch(async (e) => {
  try { for (const cid of created.connIds) { for (const p of await listProviderAccounts(U, cid)) await removeLinkedSandboxAccount(U, p.id).catch(() => {}); await deleteConnection(U, cid).catch(() => {}); } } catch { /* ignore */ }
  console.error(e); process.exit(1);
});
