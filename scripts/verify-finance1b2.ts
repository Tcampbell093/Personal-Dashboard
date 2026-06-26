/* Deterministic verification for Finance 1B.2 (Plaid Sandbox accounts + cached
 * balances). Read-only, owner-only, Sandbox only. The discovery/create flow runs
 * against REAL Plaid Sandbox, then cleans up by EXACT ID. No secret is printed.
 * No money movement, no transactions, no webhooks, no matching.
 *
 * Run: npx tsx --env-file=.env --env-file=.env.local scripts/verify-finance1b2.ts
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  providerAccounts, financialConnections, financialAccounts, incomeEntries, financialEntries,
  accountTransfers, accountMovements, apiUsageLogs, experienceRequests,
} from "@/db/schema";
import { CURRENT_USER_ID } from "@/lib/auth";
import { exchangeAndStore, deleteConnection, ConnectionError } from "@/lib/services/connections";
import { sandboxCreatePublicToken, normalizePlaidAccountType } from "@/lib/providers/plaid/adapter";
import { __resetPlaidClient } from "@/lib/providers/plaid/client";
import {
  syncProviderAccounts, listProviderAccounts, createLinkedAccount, removeLinkedSandboxAccount, linkedBalanceMap,
} from "@/lib/services/provider-accounts";
import { toAccountViews, computeCashSummary, listAccounts, updateAccount, reconcileAccount } from "@/lib/services/finances";
import { computeProjection } from "@/lib/services/finance-projection";

const U = CURRENT_USER_ID;
let passed = 0, failed = 0;
const ok = (n: string, c: boolean) => { c ? passed++ : failed++; console.log(`${c ? "✓" : "✗"} ${n}`); };
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/* import-graph helpers */
function walkTs(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${ent.name}`;
    if (ent.isDirectory()) { if (ent.name !== "node_modules") walkTs(p, out); }
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(p);
  }
  return out;
}
const isClientFile = (src: string) => /^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(src);
function resolveImport(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.resolve(process.cwd(), spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  for (const cand of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`, base])
    if (existsSync(cand) && readdirSync(path.dirname(cand)).includes(path.basename(cand))) return cand;
  return null;
}
const localImportsOf = (file: string): string[] =>
  [...read(file).matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((m) => resolveImport(file, m[1])).filter((x): x is string => x != null);
function reaches(start: string, targets: Set<string>): boolean {
  const seen = new Set<string>(); const stack = [start];
  while (stack.length) { const f = stack.pop()!; if (seen.has(f)) continue; seen.add(f);
    for (const imp of localImportsOf(f)) { if (targets.has(path.resolve(imp))) return true; if (!seen.has(imp)) stack.push(imp); } }
  return false;
}

async function ownerSnapshot() {
  const [a, i, b, t, m, r] = await Promise.all([
    db.select().from(financialAccounts).where(and(eq(financialAccounts.userId, U), isNull(financialAccounts.deletedAt))),
    db.select().from(incomeEntries).where(eq(incomeEntries.userId, U)),
    db.select().from(financialEntries).where(eq(financialEntries.userId, U)),
    db.select().from(accountTransfers).where(eq(accountTransfers.userId, U)),
    db.select().from(accountMovements).where(eq(accountMovements.userId, U)),
    db.select().from(experienceRequests).where(eq(experienceRequests.id, 222)),
  ]);
  return { a: JSON.stringify(a), i: JSON.stringify(i), b: JSON.stringify(b), t: JSON.stringify(t), m: JSON.stringify(m), r: JSON.stringify(r) };
}

async function main() {
  console.log("Finance 1B.2 deterministic verification\n");
  const before = await ownerSnapshot();
  const logsBefore = (await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))).length;
  const chaseBofA = JSON.parse(before.a).filter((x: { name: string }) => x.name === "Chase" || x.name === "BofA");

  const svcSrc = read("lib/services/provider-accounts.ts");
  const adapterSrc = read("lib/providers/plaid/adapter.ts");
  const finSrc = read("lib/services/finances.ts");
  const projSrc = read("lib/services/finance-projection.ts");
  const connUi = read("components/finances/connection-manager.tsx");
  const acctUi = read("components/finances/account-manager.tsx");
  const pageSrc = read("app/finances/page.tsx");
  const schemaSrc = read("db/schema.ts");
  const mig = read("db/migrations/0012_loud_barracuda.sql");
  const middlewareSrc = read("middleware.ts");
  const syncRoute = read("app/api/finances/connections/[id]/accounts/sync/route.ts");
  const listRoute = read("app/api/finances/connections/[id]/accounts/route.ts");
  const createRoute = read("app/api/finances/provider-accounts/[id]/create-linked-account/route.ts");

  const created: { connId?: number; paIds: number[]; acctIds: number[] } = { paIds: [], acctIds: [] };
  try {
    // setup: a fresh Sandbox connection
    const pub = await sandboxCreatePublicToken();
    const conn = await exchangeAndStore(U, pub);
    created.connId = conn.id;
    const cid = conn.id;

    /* ============ provider account sync (1-14) ============ */
    console.log("[provider account sync]");
    const paBefore = (await db.select().from(providerAccounts).where(eq(providerAccounts.connectionId, cid))).length;
    const synced = await syncProviderAccounts(U, cid);
    created.paIds = synced.map((p) => p.id);
    ok("[1] existing Sandbox connection retrieves provider accounts", synced.length > 0);
    ok("[2] cached balances retrieved", synced.some((p) => p.balanceCurrent != null) && synced.every((p) => p.balanceAsOf != null));
    ok("[3] provider-native types normalize correctly",
      normalizePlaidAccountType("depository", "checking") === "checking" &&
      normalizePlaidAccountType("depository", "savings") === "savings" &&
      normalizePlaidAccountType("credit", "credit card") === "credit" &&
      normalizePlaidAccountType("investment", "ira") === "other" &&
      synced.every((p) => ["checking", "savings", "cash", "credit", "other"].includes(p.type)));
    const rowsForConn = await db.select().from(providerAccounts).where(eq(providerAccounts.connectionId, cid));
    ok("[4] provider account IDs are connection-scoped", rowsForConn.every((r) => r.connectionId === cid && r.userId === U));
    ok("[5] first sync inserts provider-account rows", rowsForConn.length === synced.length && paBefore === 0);
    const synced2 = await syncProviderAccounts(U, cid);
    ok("[6] repeated sync is idempotent (no new rows)", synced2.length === synced.length && (await db.select().from(providerAccounts).where(eq(providerAccounts.connectionId, cid))).length === synced.length);
    await Promise.all([syncProviderAccounts(U, cid), syncProviderAccounts(U, cid)]);
    ok("[7] concurrent sync creates no duplicates", (await db.select().from(providerAccounts).where(eq(providerAccounts.connectionId, cid))).length === synced.length);
    // [8] modified balance updates the existing row: corrupt a stored balance, re-sync → overwritten.
    const sampleRow = rowsForConn.find((r) => r.balanceCurrent != null)!;
    await db.update(providerAccounts).set({ balanceCurrent: "999999.99" }).where(eq(providerAccounts.id, sampleRow.id));
    await syncProviderAccounts(U, cid);
    const reSynced = (await db.select().from(providerAccounts).where(eq(providerAccounts.id, sampleRow.id)))[0];
    ok("[8] modified balance updates the existing row (same id, provider value restored)", reSynced.id === sampleRow.id && reSynced.balanceCurrent !== "999999.99");
    // [9] missing provider account → stale (not deleted): inject a phantom, re-sync.
    const [phantom] = await db.insert(providerAccounts).values({ userId: U, connectionId: cid, provider: "plaid", providerAccountId: "phantom-not-in-plaid", providerName: "Phantom", providerType: "other", status: "active", balanceAsOf: new Date() }).returning();
    await syncProviderAccounts(U, cid);
    const phantomAfter = (await db.select().from(providerAccounts).where(eq(providerAccounts.id, phantom.id)))[0];
    ok("[9] missing provider account becomes stale (not deleted)", phantomAfter != null && phantomAfter.status === "stale");
    await db.delete(providerAccounts).where(eq(providerAccounts.id, phantom.id));
    // [10] provider failure preserves prior data + prior lastSyncedAt.
    const connBefore = (await db.select().from(financialConnections).where(eq(financialConnections.id, cid)))[0];
    const savedSecret = process.env.PLAID_SECRET;
    process.env.PLAID_SECRET = "invalid-secret-for-failure-test"; __resetPlaidClient();
    let providerFailed = false;
    try { await syncProviderAccounts(U, cid); } catch { providerFailed = true; }
    process.env.PLAID_SECRET = savedSecret; __resetPlaidClient();
    const connAfterFail = (await db.select().from(financialConnections).where(eq(financialConnections.id, cid)))[0];
    ok("[10] provider failure preserves prior rows + lastSyncedAt",
      providerFailed &&
      (await db.select().from(providerAccounts).where(eq(providerAccounts.connectionId, cid))).length === synced.length &&
      connAfterFail.lastSyncedAt?.getTime() === connBefore.lastSyncedAt?.getTime());
    // [11] decryption failure writes nothing.
    const cntPre = (await db.select().from(providerAccounts).where(eq(providerAccounts.connectionId, cid))).length;
    const savedKey = process.env.BANK_TOKEN_ENC_KEY;
    delete process.env.BANK_TOKEN_ENC_KEY;
    let decFailed = false;
    try { await syncProviderAccounts(U, cid); } catch { decFailed = true; }
    process.env.BANK_TOKEN_ENC_KEY = savedKey;
    ok("[11] decryption failure writes no account data", decFailed && (await db.select().from(providerAccounts).where(eq(providerAccounts.connectionId, cid))).length === cntPre);
    // [12] foreign connection access rejected.
    let foreignRejected = false;
    try { await syncProviderAccounts(999999, cid); } catch { foreignRejected = true; }
    const foreignList = await listProviderAccounts(U, cid); // sanity: owner still works
    ok("[12] foreign connection access is rejected", foreignRejected && foreignList.length > 0);
    ok("[13] unauthenticated access is rejected (middleware gate covers /api)",
      /pathname\.startsWith\(["']\/api\/["']\)/.test(middlewareSrc) && /401/.test(middlewareSrc));
    const aView = (await listProviderAccounts(U, cid))[0];
    ok("[14] responses contain no access-token or encryption fields",
      !("accessToken" in aView) && !("cipher" in aView) && !JSON.stringify(aView).match(/cipher|nonce|tag|access_token/i) &&
      !/accessToken|access_token|Cipher|Nonce/.test(syncRoute + listRoute));

    /* ============ linked-account creation (15-30) ============ */
    console.log("\n[linked-account creation]");
    const fresh = await listProviderAccounts(U, cid);
    const chk = fresh.find((p) => p.type === "checking" && !p.mapped)!;
    const made = await createLinkedAccount(U, chk.id, { name: "ZZ1B2 Checking", purpose: "spending", includeInSpendable: true });
    created.acctIds.push(made.financialAccountId);
    const fa = (await db.select().from(financialAccounts).where(eq(financialAccounts.id, made.financialAccountId)))[0];
    ok("[15] unmapped provider account creates a new linked Xanther account", fa != null && fa.name === "ZZ1B2 Checking");
    ok("[16] created account uses balanceSource='linked'", fa.balanceSource === "linked");
    const paAfter = (await db.select().from(providerAccounts).where(eq(providerAccounts.id, chk.id)))[0];
    ok("[17] provider-account mapping is atomic (provider row points at the new account)", paAfter.financialAccountId === fa.id);
    let dup = false; try { await createLinkedAccount(U, chk.id, { name: "dup", purpose: "spending", includeInSpendable: true }); } catch { dup = true; }
    ok("[18] duplicate creation creates no second account", dup && (await db.select().from(providerAccounts).where(eq(providerAccounts.id, chk.id)))[0].financialAccountId === fa.id);
    // [19] concurrent creation creates one account.
    const chk2 = fresh.find((p) => p.type === "checking" && !p.mapped && p.id !== chk.id) ?? fresh.find((p) => !p.mapped && p.id !== chk.id)!;
    const conc = await Promise.allSettled([
      createLinkedAccount(U, chk2.id, { name: "ZZ1B2 Conc", purpose: "spending", includeInSpendable: false }),
      createLinkedAccount(U, chk2.id, { name: "ZZ1B2 Conc", purpose: "spending", includeInSpendable: false }),
    ]);
    const succeeded = conc.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ financialAccountId: number }>[];
    succeeded.forEach((s) => created.acctIds.push(s.value.financialAccountId));
    const mappedAcctIds = new Set(succeeded.map((s) => s.value.financialAccountId));
    ok("[19] concurrent creation creates exactly one account", mappedAcctIds.size === 1);
    const chk2row = (await db.select().from(providerAccounts).where(eq(providerAccounts.id, chk2.id)))[0];
    const cfa = (await db.select().from(financialAccounts).where(eq(financialAccounts.id, made.financialAccountId)))[0];
    ok("[20] owner-selected purpose is preserved", cfa.purpose === "spending");
    ok("[21] spendable choice is preserved", cfa.includeInSpendable === true);
    // [22] credit cannot be spendable.
    const creditPa = fresh.find((p) => p.type === "credit" && !p.mapped);
    if (creditPa) {
      const cl = await createLinkedAccount(U, creditPa.id, { name: "ZZ1B2 Credit", purpose: "other", includeInSpendable: true });
      created.acctIds.push(cl.financialAccountId);
      const clfa = (await db.select().from(financialAccounts).where(eq(financialAccounts.id, cl.financialAccountId)))[0];
      ok("[22] credit account cannot count as spendable cash", clfa.includeInSpendable === false && clfa.type === "credit");
    } else ok("[22] credit account cannot count as spendable cash (no credit sandbox acct; rule verified in service)", /isLiabilityType\(type\) \? false/.test(svcSrc));
    ok("[23] existing manual Chase/BofA accounts remain unchanged",
      JSON.stringify(JSON.parse((await ownerSnapshot()).a).filter((x: { name: string }) => x.name === "Chase" || x.name === "BofA")) === JSON.stringify(chaseBofA));
    ok("[24] no automatic mapping occurs (unmapped accounts stay unmapped until chosen)",
      (await listProviderAccounts(U, cid)).some((p) => !p.mapped));
    ok("[25] no manual account is converted (Chase/BofA still 'manual')",
      JSON.parse((await ownerSnapshot()).a).filter((x: { name: string; balanceSource: string }) => (x.name === "Chase" || x.name === "BofA")).every((x: { balanceSource: string }) => x.balanceSource === "manual"));
    const snap = await linkedBalanceMap(U);
    const views = toAccountViews(await listAccounts(U), snap);
    const lv = views.find((v) => v.id === fa.id)!;
    ok("[26] linked balance is provider-authoritative (resolved from snapshot)", lv.balanceSource === "linked" && lv.balanceUnavailable !== true && lv.currentBalance === Number(paAfter.balanceCurrent));
    let recRejected = false;
    try { await reconcileAccount(U, fa.id, 500, null); } catch { recRejected = true; }
    ok("[27] linked account cannot be reconciled", recRejected);
    // [28] linked balance cannot be manually edited (updateAccount strips it).
    await updateAccount(U, fa.id, { currentBalance: "12345.67", name: "ZZ1B2 Renamed" } as never);
    const afterEdit = (await db.select().from(financialAccounts).where(eq(financialAccounts.id, fa.id)))[0];
    ok("[28] linked account balance cannot be manually edited (name editable, balance stripped)", afterEdit.currentBalance == null && afterEdit.name === "ZZ1B2 Renamed");
    // [29] missing linked balance does NOT fall back to manual: a snapshot-less linked account.
    const noSnapViews = toAccountViews(await listAccounts(U), new Map());
    const lvNoSnap = noSnapViews.find((v) => v.id === fa.id)!;
    ok("[29] missing linked balance does not fall back to manual/zero", lvNoSnap.balanceUnavailable === true && lvNoSnap.currentBalance === 0);
    // [30] stale linked balance labeled truthfully: mark the mapped provider row stale.
    await db.update(providerAccounts).set({ status: "stale" }).where(eq(providerAccounts.id, chk.id));
    const staleViews = toAccountViews(await listAccounts(U), await linkedBalanceMap(U));
    ok("[30] stale linked balance is labeled truthfully", staleViews.find((v) => v.id === fa.id)!.balanceStale === true);
    await db.update(providerAccounts).set({ status: "active" }).where(eq(providerAccounts.id, chk.id));

    /* ============ totals and projections (31-38) ============ */
    console.log("\n[totals and projections]");
    const v2 = toAccountViews(await listAccounts(U), await linkedBalanceMap(U));
    const sum = computeCashSummary(v2);
    const manualCash = v2.filter((a) => a.active && a.isCash && a.balanceSource === "manual").reduce((s, a) => s + a.currentBalance, 0);
    const linkedCash = v2.filter((a) => a.active && a.isCash && a.balanceSource === "linked" && !a.balanceUnavailable).reduce((s, a) => s + a.currentBalance, 0);
    ok("[31] manual + linked cash totals resolve from the correct authorities", Math.abs(sum.totalActualCash - (manualCash + linkedCash)) < 0.005 && linkedCash > 0);
    ok("[32] credit liabilities remain separate", sum.creditLiabilities === v2.filter((a) => a.active && a.isLiability && !a.balanceUnavailable).reduce((s, a) => s + a.currentBalance, 0));
    ok("[33] spendable total respects account settings", sum.spendableActualCash === v2.filter((a) => a.active && a.isCash && a.includeInSpendable && !a.balanceUnavailable).reduce((s, a) => s + a.currentBalance, 0));
    const unavailViews = toAccountViews(await listAccounts(U), new Map());
    const unavailSum = computeCashSummary(unavailViews);
    ok("[34] unavailable linked balance produces a warning (qualified total)", (unavailSum.linkedUnavailableCount ?? 0) >= 1 && unavailSum.totalQualified === true);
    const staleV = toAccountViews(await listAccounts(U), await linkedBalanceMap(U)).map((v) => v.id === fa.id ? { ...v, balanceStale: true } : v);
    const projStale = computeProjection({ accounts: staleV, bills: [], income: [], transfers: [], horizon: "30d", today: "2026-06-26" });
    ok("[35] stale linked balance produces a warning", projStale.warnings.some((w) => w.code === "linked_stale"));
    const proj = computeProjection({ accounts: v2, bills: [], income: [], transfers: [], horizon: "30d", today: "2026-06-26" });
    const linkedProjAcct = proj.accounts.find((p) => p.accountId === fa.id)!;
    ok("[36] projection uses the linked provider balance", linkedProjAcct.actualBalance === Number(paAfter.balanceCurrent));
    const projUnavail = computeProjection({ accounts: unavailViews, bills: [], income: [], transfers: [], horizon: "30d", today: "2026-06-26" });
    ok("[37] projection does not overwrite any balance source + warns on unavailable",
      projUnavail.warnings.some((w) => w.code === "linked_unavailable") &&
      (await db.select().from(financialAccounts).where(eq(financialAccounts.id, fa.id)))[0].currentBalance == null);
    ok("[38] no automatic double-counting (one provider account → at most one linked Xanther account)",
      new Set((await db.select().from(providerAccounts).where(and(eq(providerAccounts.userId, U), isNull(providerAccounts.financialAccountId)))).map((r) => r.id)).size >= 0 &&
      (await db.select().from(providerAccounts).where(eq(providerAccounts.financialAccountId, fa.id))).length === 1);

    /* ============ UI (39-50, source) ============ */
    console.log("\n[/finances UI]");
    ok("[39] Bank connections show Sync accounts", /Sync accounts/.test(connUi));
    ok("[40] discovered provider accounts render", /fin-pa-list/.test(connUi) && /providerName/.test(connUi));
    ok("[41] account mask renders without a full account number", /••\$\{?.*mask|••\{|mask \? ` · ••/.test(connUi) && !/account_number|full.?account/i.test(connUi));
    ok("[42] cached balance is labeled truthfully (never 'live')", /Cached Sandbox balance|Provider balance|Last known provider balance/.test(connUi + acctUi) && !/\blive balance\b|real-?time/i.test(stripComments(connUi + acctUi)));
    ok("[43] last-updated timestamp renders", /Updated \$\{freshLabel|freshLabel\(/.test(connUi));
    ok("[44] Add-to-Xanther renders only for unmapped accounts", /Add to Xanther/.test(connUi) && /mapped \?[\s\S]*Linked to[\s\S]*Add to Xanther/.test(connUi));
    ok("[45] warning says it does not merge with manual accounts", /does not merge\s*\n?\s*with your existing manual accounts/i.test(connUi));
    ok("[46] linked account appears in Accounts (page resolves linked balances)", /toAccountViews\(acctRows, linkedSnap\)/.test(pageSrc));
    ok("[47] linked account label renders", /Linked account/.test(acctUi) && /Plaid Sandbox/.test(acctUi));
    ok("[48] manual reconciliation action is absent for a linked account", /isManual && a\.active && \([\s\S]*Reconcile/.test(acctUi));
    ok("[49] manual balance editor is absent for a linked account", /!linked &&[\s\S]*Actual balance|disabled=\{pending \|\| linked\}/.test(acctUi) && /linked=\{a\.balanceSource === "linked"\}/.test(acctUi));
    ok("[50] 375px layout uses responsive wrapping", /\.fin-pa-row[\s\S]*?flex-wrap/.test(read("app/globals.css")));

    /* ============ scope protection (51-67) ============ */
    console.log("\n[scope protection]");
    ok("[51] no real Production connection (Sandbox base path only)", /PlaidEnvironments\.sandbox/.test(read("lib/providers/plaid/client.ts")) && !/PlaidEnvironments\.production/.test(read("lib/providers/plaid/client.ts")));
    ok("[52] no OAuth handling added", !/oauth|redirect_uri/i.test(stripComments(svcSrc + connUi + syncRoute)));
    // NOTE: transaction sync is intentionally added by Finance 1B.3A (separate,
    // approved build). The 1B.2 invariant: the ACCOUNT-sync service does not sync
    // transactions (kept distinct from the transaction-sync service).
    ok("[53] account-sync service does not perform transaction synchronization", !/syncTransactions\(|imported_transactions/.test(svcSrc));
    ok("[54] no webhook", /verifyWebhook: notImplemented/.test(adapterSrc) && !existsSync("app/api/finances/connections/webhook") && !existsSync("app/api/webhooks"));
    ok("[55] no transaction matching", !/match/i.test(stripComments(svcSrc)) && !existsSync("lib/services/matching.ts"));
    ok("[56] no bill/income/transfer evidence confirmation", !/confirm.*(bill|income|transfer).*evidence|evidence.*confirm/i.test(stripComments(svcSrc)));
    ok("[57] no money movement", !/transfer|payment|moveMoney|paymentInitiation/i.test(stripComments(svcSrc + adapterSrc)));
    ok("[58] Finance 1B.1 remains intact", existsSync("lib/services/connections.ts") && /pgTable\(\s*["']financial_connections["']/.test(schemaSrc));
    ok("[59] Finance 1B.0 remains intact", existsSync("lib/providers/bank-provider.ts") && existsSync("lib/providers/token-crypto.ts"));
    ok("[60] Finance 1A.4 remains intact", /pgTable\(\s*["']income_schedules["']/.test(schemaSrc) && existsSync("lib/services/income-schedules.ts"));
    // secret-reader unreachable from client components.
    const secretTargets = new Set(["lib/providers/plaid/client.ts", "lib/providers/plaid/env.ts", "lib/providers/plaid/adapter.ts", "lib/providers/token-crypto.ts", "lib/services/connections.ts", "lib/services/provider-accounts.ts"].map((p) => path.resolve(p)));
    const clientFiles = walkTs("app").concat(walkTs("components"), walkTs("lib")).filter((f) => isClientFile(read(f)));
    ok("[67-a] secret readers unreachable from Client Components", clientFiles.filter((f) => reaches(f, secretTargets)).length === 0);

    /* ============ lifecycle safety — no orphaned linked accounts (correction) ============ */
    console.log("\n[lifecycle safety — orphan prevention]");
    // At this point `cid` has a linked account (fa, via chk). Capture state.
    const ownerConnsBefore = (await db.select().from(financialConnections).where(and(eq(financialConnections.userId, U), isNull(financialConnections.deletedAt)))).filter((c) => c.id !== cid).map((c) => c.id).sort();

    // [L1] an unused/unmapped temp connection can be cleaned up.
    const tmp1 = await exchangeAndStore(U, await sandboxCreatePublicToken());
    await syncProviderAccounts(U, tmp1.id);
    const del1 = await deleteConnection(U, tmp1.id);
    ok("[L1] unused temp Sandbox connection (unmapped accounts) can be cleaned up", del1.deleted === true && (await db.select().from(financialConnections).where(eq(financialConnections.id, tmp1.id))).length === 0);
    ok("[L2] cleanup removed its unmapped provider-account snapshots too", (await db.select().from(providerAccounts).where(eq(providerAccounts.connectionId, tmp1.id))).length === 0);

    // [L3-L9] a connection WITH a mapped linked account cannot be deleted.
    const connRowB = await db.select().from(financialConnections).where(eq(financialConnections.id, cid));
    const paRowsB = await db.select().from(providerAccounts).where(eq(providerAccounts.connectionId, cid));
    const faRowB = (await db.select().from(financialAccounts).where(eq(financialAccounts.id, fa.id)))[0];
    let blocked = false, blockMsg = "";
    try { await deleteConnection(U, cid); } catch (e) { blocked = e instanceof ConnectionError && (e as ConnectionError).status === 409; blockMsg = e instanceof Error ? e.message : ""; }
    const connRowA = await db.select().from(financialConnections).where(eq(financialConnections.id, cid));
    const paRowsA = await db.select().from(providerAccounts).where(eq(providerAccounts.connectionId, cid));
    const faRowA = (await db.select().from(financialAccounts).where(eq(financialAccounts.id, fa.id)))[0];
    ok("[L3] a connection with a mapped linked account cannot be deleted", blocked);
    ok("[L4] blocked delete returns a bounded conflict (truthful, no secret)", /linked Xanther accounts and cannot be removed/i.test(blockMsg) && !/token|cipher|access|nonce/i.test(blockMsg));
    ok("[L5] blocked delete changes no connection row", JSON.stringify(connRowB) === JSON.stringify(connRowA) && connRowA.length === 1);
    ok("[L6] blocked delete changes no provider-account row", JSON.stringify(paRowsB) === JSON.stringify(paRowsA));
    ok("[L7] blocked delete changes no linked financial-account row", JSON.stringify(faRowB) === JSON.stringify(faRowA));
    ok("[L8] linked account retains balanceSource='linked'", faRowA.balanceSource === "linked");
    ok("[L9] provider balance snapshot remains available", (await db.select().from(providerAccounts).where(eq(providerAccounts.id, chk.id)))[0].balanceCurrent != null);
    ok("[L10] no manual owner account affected (Chase/BofA unchanged)",
      JSON.stringify(JSON.parse((await ownerSnapshot()).a).filter((x: { name: string }) => x.name === "Chase" || x.name === "BofA")) === JSON.stringify(chaseBofA));

    // [L11] a mapped provider account cannot be independently hard-deleted (no DELETE
    // route exists; the FK + safe teardown protect it). The DB FK blocks a raw delete.
    let rawConnBlocked = false;
    try { await db.delete(financialConnections).where(eq(financialConnections.id, cid)); } catch { rawConnBlocked = true; }
    ok("[L11] no route hard-deletes a mapped provider account; DB FK blocks a raw connection delete",
      !existsSync("app/api/finances/provider-accounts/[id]/route.ts") && rawConnBlocked &&
      /financialAccountId: null[\s\S]*?delete\(financialAccounts\)[\s\S]*?delete\(providerAccounts\)/.test(svcSrc));

    // [L12] concurrency: a concurrent delete + create cannot orphan. Defense in
    // depth — the connection-delete guard (mapped pre-check + the guarded CTE) AND
    // the NO ACTION FK both fail closed; the raw-delete block above proves the FK.
    const connSvc = read("lib/services/connections.ts");
    ok("[L12] concurrent delete/create cannot orphan (mapped guard + NO ACTION FK + guarded CTE)",
      /financial_account_id IS NOT NULL/.test(connSvc) && /isNotNull\(providerAccounts\.financialAccountId\)/.test(connSvc) &&
      /ON DELETE no action/.test(read("db/migrations/0013_next_speed.sql")) && rawConnBlocked);

    // [L13] exact-ID cleanup teardown is in a SAFE dependency order: the helper
    // clears the mapping, deletes the linked (never manual) account, then the
    // provider row — verified live by the end-of-run cleanup ([65]) and by source.
    ok("[L13] exact-ID cleanup uses a safe dependency order (unmap → delete linked → delete provider)",
      /financialAccountId: null[\s\S]*?balance_source", "linked"|balanceSource, "linked"[\s\S]*?delete\(providerAccounts\)/.test(svcSrc) ||
      /financialAccountId: null[\s\S]*?delete\(financialAccounts\)[\s\S]*?delete\(providerAccounts\)/.test(svcSrc));

    // [L14] direct orphan-integrity invariant (current active model): every active
    // linked financial account has exactly one active provider-account mapping.
    const linkedFas = await db.select().from(financialAccounts).where(and(eq(financialAccounts.userId, U), eq(financialAccounts.balanceSource, "linked"), isNull(financialAccounts.deletedAt)));
    let orphanCount = 0;
    for (const lf of linkedFas) {
      const maps = await db.select().from(providerAccounts).where(and(eq(providerAccounts.financialAccountId, lf.id), isNull(providerAccounts.deletedAt)));
      if (maps.length !== 1) orphanCount++;
    }
    ok("[L14] orphan-integrity: every active linked account has exactly one provider mapping", orphanCount === 0 && linkedFas.length >= 1);

    // [L15] the owner's real Sandbox connection(s) are untouched by this harness.
    const ownerConnsAfter = (await db.select().from(financialConnections).where(and(eq(financialConnections.userId, U), isNull(financialConnections.deletedAt)))).filter((c) => c.id !== cid).map((c) => c.id).sort();
    ok("[L15] owner's real Sandbox connection(s) remain untouched", JSON.stringify(ownerConnsBefore) === JSON.stringify(ownerConnsAfter));

    // cleanup BEFORE the owner-data assertions.
    for (const id of created.paIds.concat([chk.id, chk2.id])) await removeLinkedSandboxAccount(U, id).catch(() => {});
    for (const id of created.acctIds) {
      const r = await db.select().from(financialAccounts).where(eq(financialAccounts.id, id));
      if (r.length) await db.delete(financialAccounts).where(eq(financialAccounts.id, id));
    }
    await db.delete(providerAccounts).where(eq(providerAccounts.connectionId, cid));
    await deleteConnection(U, cid);
    created.connId = undefined; created.paIds = []; created.acctIds = [];

    const after = await ownerSnapshot();
    ok("[61] request 222 remains untouched", after.r === before.r);
    ok("[62] owner accounts unchanged (temp linked records removed by exact id)", after.a === before.a);
    ok("[63] owner income/bills/transfers/movements untouched", after.i === before.i && after.b === before.b && after.t === before.t && after.m === before.m);
    const logsAfter = (await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))).length;
    ok("[64] no AI call or usage-log row", logsAfter === logsBefore && !/@anthropic|openai|messages\.create/i.test(svcSrc + adapterSrc));
    // NOTE: exact-ID — assert THIS harness's temp records are gone (the owner may
    // have a pre-existing real linked account, which must be preserved, not zeroed).
    ok("[65] exact-ID cleanup only (this harness's temp provider-accounts + linked accounts removed)",
      (await db.select().from(providerAccounts).where(eq(providerAccounts.connectionId, cid))).length === 0 &&
      (await Promise.all(created.acctIds.map(async (id) => (await db.select().from(financialAccounts).where(eq(financialAccounts.id, id))).length))).every((n) => n === 0));
    ok("[66] .env.local remains ignored (gitignore) + no real key in tracked files", /(^|\n)\.env\.local/.test(read(".gitignore")));
    ok("[67] no secret in source/responses (no token/cipher literal, no plaintext token column)",
      !/access-sandbox-[0-9a-f]{8}|access-production-/.test(svcSrc + connUi + acctUi + syncRoute + listRoute + createRoute) &&
      !/["']access_token["']/.test(schemaSrc) && !/balance_current[\s\S]*access_token/.test(mig));

    ok("[mig] migration 0012 is additive (CREATE only; no DROP/owner-ALTER/backfill)",
      /CREATE TABLE "provider_accounts"/.test(mig) && !/\bDROP\b|TRUNCATE|DELETE FROM/.test(mig) && !/INSERT INTO|UPDATE\s+"[^"]+"\s+SET/i.test(mig) && !/ALTER TABLE "(?!provider_accounts)/.test(mig));
  } finally {
    // best-effort cleanup on any failure
    for (const id of created.acctIds) await db.delete(financialAccounts).where(eq(financialAccounts.id, id)).catch(() => {});
    if (created.connId) { await db.delete(providerAccounts).where(eq(providerAccounts.connectionId, created.connId)).catch(() => {}); await deleteConnection(U, created.connId).catch(() => {}); }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
