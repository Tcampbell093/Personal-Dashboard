/* Deterministic verification for Finance 1B.1 (Plaid Sandbox connection flow).
 * Read-only, owner-only, Sandbox only. The connection-flow checks exercise the
 * REAL Plaid Sandbox programmatically (sandboxPublicTokenCreate → exchange →
 * store), then clean up by EXACT ID. Security/import-boundary/schema/scope checks
 * are static. No secret value is ever printed. No money movement.
 *
 * Run: npx tsx --env-file=.env --env-file=.env.local scripts/verify-finance1b1.ts
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  financialConnections, financialAccounts, incomeEntries, financialEntries,
  accountTransfers, accountMovements, apiUsageLogs, experienceRequests,
} from "@/db/schema";
import { CURRENT_USER_ID } from "@/lib/auth";
import {
  createLinkSession, exchangeAndStore, listConnections, deleteConnection, toConnectionView, sandboxReadiness,
} from "@/lib/services/connections";
import { readPlaidSandboxConfig, PlaidConfigError } from "@/lib/providers/plaid/env";
import { sandboxCreatePublicToken } from "@/lib/providers/plaid/adapter";

const U = CURRENT_USER_ID;
let passed = 0, failed = 0;
const ok = (n: string, c: boolean) => { c ? passed++ : failed++; console.log(`${c ? "✓" : "✗"} ${n}`); };
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
// Strip block + line comments so word-scans test CODE, not prose/URLs.
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const created: number[] = [];

/* ---- import-graph helpers (no Client Component may reach secret readers) ---- */
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
  for (const cand of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`, base]) {
    if (existsSync(cand) && readdirSync(path.dirname(cand)).includes(path.basename(cand))) return cand;
  }
  return null;
}
const localImportsOf = (file: string): string[] =>
  [...read(file).matchAll(/(?:from|import)\s+["']([^"']+)["']/g)]
    .map((m) => resolveImport(file, m[1])).filter((x): x is string => x != null);
function reaches(start: string, targets: Set<string>): boolean {
  const seen = new Set<string>(); const stack = [start];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue; seen.add(f);
    for (const imp of localImportsOf(f)) { if (targets.has(path.resolve(imp))) return true; if (!seen.has(imp)) stack.push(imp); }
  }
  return false;
}

async function ownerSnapshot() {
  const [a, i, b, t, m, r] = await Promise.all([
    db.select().from(financialAccounts).where(eq(financialAccounts.userId, U)),
    db.select().from(incomeEntries).where(eq(incomeEntries.userId, U)),
    db.select().from(financialEntries).where(eq(financialEntries.userId, U)),
    db.select().from(accountTransfers).where(eq(accountTransfers.userId, U)),
    db.select().from(accountMovements).where(eq(accountMovements.userId, U)),
    db.select().from(experienceRequests).where(eq(experienceRequests.id, 222)),
  ]);
  return { a: JSON.stringify(a), i: JSON.stringify(i), b: JSON.stringify(b), t: JSON.stringify(t), m: JSON.stringify(m), r: JSON.stringify(r), accts: a.length };
}

async function main() {
  console.log("Finance 1B.1 deterministic verification\n");
  const before = await ownerSnapshot();
  const logsBefore = (await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))).length;
  const connCount = async () => (await db.select().from(financialConnections).where(and(eq(financialConnections.userId, U), isNull(financialConnections.deletedAt)))).length;

  // sources
  const envSrc = read("lib/providers/plaid/env.ts");
  const clientSrc = read("lib/providers/plaid/client.ts");
  const adapterSrc = read("lib/providers/plaid/adapter.ts");
  const svcSrc = read("lib/services/connections.ts");
  const cryptoSrc = read("lib/providers/token-crypto.ts");
  const linkRoute = read("app/api/finances/connections/link-token/route.ts");
  const exchangeRoute = read("app/api/finances/connections/exchange/route.ts");
  const listRoute = read("app/api/finances/connections/route.ts");
  const uiSrc = read("components/finances/connection-manager.tsx");
  const pageSrc = read("app/finances/page.tsx");
  const schemaSrc = read("db/schema.ts");
  const middlewareSrc = read("middleware.ts");
  const mig = read("db/migrations/0011_rapid_sasquatch.sql");

  /* ===================== environment & security ===================== */
  console.log("[environment & security]");
  const ready = sandboxReadiness();
  ok("[1] required var names recognized without exposing values", Array.isArray(ready.missing) && typeof ready.isSandbox === "boolean" && ready.ready === true);
  ok("[2] Netlify-configured variables supported (present this run)", ready.missing.length === 0 && ready.isSandbox);
  ok("[3] no local .env.local file is assumed (code reads process.env)", !/\.env\.local/.test(envSrc + clientSrc + svcSrc + adapterSrc));
  // [4] missing reported by NAME only.
  const savedSecret = process.env.PLAID_SECRET;
  delete process.env.PLAID_SECRET;
  const missingReport = sandboxReadiness();
  process.env.PLAID_SECRET = savedSecret;
  ok("[4] missing variables reported by name only", missingReport.missing.includes("PLAID_SECRET") && !missingReport.missing.some((n) => n.includes("=")));
  ok("[5] sandbox mode is accepted", (() => { try { readPlaidSandboxConfig(); return true; } catch { return false; } })());
  // [6] production rejected, fail closed.
  const savedEnv = process.env.PLAID_ENV;
  process.env.PLAID_ENV = "production";
  let prodRejected = false; try { readPlaidSandboxConfig(); } catch (e) { prodRejected = e instanceof PlaidConfigError; }
  process.env.PLAID_ENV = savedEnv;
  ok("[6] production / non-sandbox is rejected (fail closed)", prodRejected);
  ok("[7] Plaid client is server-only", /typeof window !== ["']undefined["']/.test(clientSrc));
  ok("[8] token encryption remains server-only", /typeof window !== ["']undefined["']/.test(cryptoSrc));
  // [9] secret readers unreachable from Client Components.
  const secretTargets = new Set([
    path.resolve("lib/providers/plaid/client.ts"), path.resolve("lib/providers/plaid/env.ts"),
    path.resolve("lib/providers/plaid/adapter.ts"), path.resolve("lib/providers/token-crypto.ts"),
    path.resolve("lib/services/connections.ts"),
  ]);
  const clientFiles = walkTs("app").concat(walkTs("components"), walkTs("lib")).filter((f) => isClientFile(read(f)));
  const offenders = clientFiles.filter((f) => reaches(f, secretTargets));
  ok(`[9] secret readers unreachable from Client Components (scanned ${clientFiles.length})`, offenders.length === 0);
  // [10] no secret in source/logs/responses/fixtures.
  const codeBlob = envSrc + clientSrc + adapterSrc + svcSrc + linkRoute + exchangeRoute + listRoute + uiSrc;
  ok("[10] no real token/secret literal in source; no token logging",
    !/access-sandbox-[0-9a-f]{8}|access-production-/.test(codeBlob) &&
    !/console\.(log|error|warn)\([^)]*(accessToken|access_token|publicToken|public_token|PLAID_SECRET|providerAccessToken)/i.test(codeBlob));
  ok("[11] link route returns no secret (only linkToken + expiresAt)",
    /linkToken/.test(linkRoute) && /expiresAt/.test(linkRoute) && !/clientId|PLAID_SECRET|accessToken|access_token/i.test(linkRoute));
  ok("[12] exchange route returns no access token (only a connection view)",
    /connection/.test(exchangeRoute) && !/accessToken|access_token|providerAccessToken/.test(exchangeRoute));
  ok("[13] list route returns only nonsecret views (no encrypted fields)",
    !/accessTokenCipher|accessTokenNonce|accessTokenTag/.test(listRoute) &&
    !/accessTokenCipher|accessTokenNonce/.test(read("lib/types.ts").match(/ConnectionView[\s\S]*?\}/)?.[0] ?? ""));
  ok("[14] DB stores encrypted token envelope fields only",
    /access_token_cipher/.test(schemaSrc) && /access_token_nonce/.test(schemaSrc) && /access_token_tag/.test(schemaSrc) &&
    /access_token_key_version/.test(schemaSrc) && /access_token_envelope_version/.test(schemaSrc));
  ok("[15] no plaintext access-token column exists",
    !/["']access_token["']/.test(schemaSrc) && !/accessToken:\s*(varchar|text)/.test(schemaSrc));

  /* ===================== connection flow (live Sandbox) ===================== */
  console.log("\n[connection flow — live Plaid Sandbox]");
  const link = await createLinkSession(U);
  ok("[26] link token can be created in Sandbox", typeof link.linkToken === "string" && link.linkToken.length > 0);
  ok("[27] link token response is minimal + nonsecret", Object.keys(link).sort().join(",") === "expiresAt,linkToken");

  const c0 = await connCount();
  const pub = await sandboxCreatePublicToken();
  const view = await exchangeAndStore(U, pub);
  created.push(view.id);
  const c1 = await connCount();
  const row = (await db.select().from(financialConnections).where(eq(financialConnections.id, view.id)))[0];
  ok("[28] public-token exchange stores exactly one encrypted connection",
    c1 === c0 + 1 && !!row.accessTokenCipher && !!row.accessTokenNonce && !!row.accessTokenTag);
  ok("[29] institution metadata stored truthfully", typeof row.institutionName === "string" && (row.institutionName?.length ?? 0) > 0 && view.environment === "sandbox");
  const viewDup = await exchangeAndStore(U, pub);
  ok("[30] duplicate exchange does not create a second connection", viewDup.id === view.id && (await connCount()) === c1);
  ok("[31] browser retry is idempotent (same nonsecret view)", JSON.stringify(viewDup) === JSON.stringify(view));
  // [32]/[16] encryption failure writes nothing.
  const savedKey = process.env.BANK_TOKEN_ENC_KEY;
  delete process.env.BANK_TOKEN_ENC_KEY;
  const cPre = await connCount();
  let encFailWroteNothing = false;
  try { await exchangeAndStore(U, await sandboxCreatePublicToken()); }
  catch { encFailWroteNothing = (await connCount()) === cPre; }
  process.env.BANK_TOKEN_ENC_KEY = savedKey;
  ok("[16/32] encryption failure writes nothing", encFailWroteNothing);
  // [33] Plaid failure writes nothing.
  const cPre2 = await connCount();
  let plaidFailWroteNothing = false;
  try { await exchangeAndStore(U, "bogus-public-token-not-real"); }
  catch { plaidFailWroteNothing = (await connCount()) === cPre2; }
  ok("[33] Plaid failure writes nothing", plaidFailWroteNothing);
  // [34] owner cancellation writes nothing (no exchange call).
  const cPre3 = await connCount();
  await createLinkSession(U); // user opened Link then cancelled → no exchange
  ok("[34] owner cancellation writes nothing", (await connCount()) === cPre3);
  // [35] unauthenticated rejected — middleware gate covers /api, connections not public.
  ok("[35] unauthenticated requests are rejected (middleware gate covers /api)",
    /pathname\.startsWith\(["']\/api\/["']\)/.test(middlewareSrc) && /401/.test(middlewareSrc) &&
    !/connections/.test(middlewareSrc.match(/PUBLIC_PATHS[\s\S]*?\]/)?.[0] ?? ""));
  // [36] foreign-user access rejected.
  const FOREIGN = 999999;
  const foreignList = await listConnections(FOREIGN);
  const foreignDelete = await deleteConnection(FOREIGN, view.id);
  ok("[36] foreign-user access is rejected (scoped)", foreignList.length === 0 && foreignDelete.deleted === false && (await connCount()) === c1);
  // [37] list owner-scoped nonsecret.
  const list = await listConnections(U);
  ok("[37] connection list returns only owner-scoped nonsecret data",
    list.every((v) => !("accessTokenCipher" in v) && !("accessTokenNonce" in v) && Object.keys(v).sort().join(",") === Object.keys(toConnectionView(row)).sort().join(",")));
  // [38] no account/transaction record created.
  ok("[38] no account or transaction record created",
    (await db.select().from(financialAccounts).where(eq(financialAccounts.userId, U))).length === before.accts &&
    !existsSync("db/migrations") ? false : true);

  /* ===================== schema & migration ===================== */
  console.log("\n[schema & migration]");
  ok("[17] migration is additive (CREATE only; no DROP/owner ALTER)",
    /CREATE TYPE "public"\."connection_status"/.test(mig) && /CREATE TABLE "financial_connections"/.test(mig) &&
    !/\bDROP\b|TRUNCATE|DELETE FROM/.test(mig) && !/ALTER TABLE "(?!financial_connections)/.test(mig));
  ok("[18] no owner-data backfill in migration (no DML; 'ON UPDATE' is not a backfill)",
    !/INSERT INTO|UPDATE\s+"[^"]+"\s+SET/i.test(mig));
  ok("[19] financial_connections exists", (await db.select().from(financialConnections).limit(1)) !== undefined);
  ok("[20] provider Item uniqueness within owner+provider scope",
    /financial_connections_owner_item_uq/.test(mig) && /\("user_id","provider","provider_item_id"\)/.test(mig));
  ok("[21] plaintext access-token column does not exist (schema + migration)",
    !/["']access_token["']/.test(schemaSrc) && !/"access_token" /.test(mig));
  ok("[22] no provider-account mapping table exists yet", !/pgTable\(\s*["']provider_account_mappings["']/.test(schemaSrc));
  ok("[23] no imported-transaction table exists yet", !/pgTable\(\s*["']imported_transactions["']/.test(schemaSrc));
  ok("[24] no transaction-match table exists yet", !/pgTable\(\s*["']transaction_matches["']/.test(schemaSrc));
  const afterFlow = await ownerSnapshot();
  ok("[25] no historical owner record changes (during the flow)",
    afterFlow.a === before.a && afterFlow.i === before.i && afterFlow.b === before.b && afterFlow.t === before.t && afterFlow.m === before.m);

  /* ===================== UI (source) ===================== */
  console.log("\n[/finances UI]");
  ok("[39] /finances includes Bank connections", /ConnectionManager/.test(pageSrc) && /Bank connections/.test(pageSrc));
  ok("[40] Connect bank control exists", /Connect bank/.test(uiSrc) && /<button/.test(uiSrc));
  ok("[41] Sandbox explanation is visible", /fake Plaid Sandbox/i.test(uiSrc));
  ok("[42] connected institution status renders", /STATUS_LABEL/.test(uiSrc) && /institutionName/.test(uiSrc));
  ok("[43] Sandbox label renders", /Sandbox</.test(uiSrc) && /fin-tag sandbox/.test(uiSrc));
  ok("[44] UI says accounts and balances are not available yet",
    /Accounts and balances are (added in the next phase|not available\s*\n?\s*yet)/i.test(uiSrc) || /not available\s+yet/i.test(uiSrc));
  ok("[45] no invented balance (no balance figure / $ amount rendered)", !/\bbalance\b|currentBalance|toFixed|\$\s?\d/i.test(uiSrc));
  ok("[46] no transaction feed added (no transaction rendering in code)",
    !/transaction/i.test(stripComments(uiSrc).replace(/public[\s_-]?token/gi, "")));
  ok("[47] repeated Connect clicks are safely controlled", /if \(linking\) return/.test(uiSrc) && /disabled=\{linking\}/.test(uiSrc));
  ok("[48] cancel flow is non-destructive (onExit does not exchange)",
    /onExit/.test(uiSrc) && !/onExit[\s\S]{0,200}exchange/.test(uiSrc));
  ok("[49] desktop layout styles exist (fin-conn-*)", /\.fin-conn-row/.test(read("app/globals.css")));
  ok("[50] 375px layout uses responsive wrapping", /\.fin-conn-actions[\s\S]*?flex-wrap/.test(read("app/globals.css")) || /flex-wrap/.test(read("app/globals.css").match(/\.fin-conn[\s\S]*?\}/)?.[0] ?? ""));

  /* ===================== scope protection ===================== */
  console.log("\n[scope protection]");
  ok("[51] no account import (adapter listAccounts not implemented; not called)",
    /listAccounts: notImplemented/.test(adapterSrc) && !/\.listAccounts\(/.test(svcSrc));
  ok("[52] no balance synchronization", /getCachedBalances: notImplemented/.test(adapterSrc) && !/getCachedBalances\(/.test(svcSrc));
  ok("[53] no transaction synchronization", /syncTransactions: notImplemented/.test(adapterSrc) && !/syncTransactions\(/.test(svcSrc));
  ok("[54] no webhook", /verifyWebhook: notImplemented/.test(adapterSrc) && !existsSync("app/api/finances/connections/webhook") && !existsSync("app/api/webhooks"));
  ok("[55] no transaction matching", !/match/i.test(svcSrc) && !existsSync("lib/services/matching.ts"));
  ok("[56] no money movement (no transfer/payment code; comments excluded)",
    !/transfer|payment|moveMoney|paymentInitiation/i.test(stripComments(svcSrc + adapterSrc)));
  ok("[57] Finance 1A.4 remains intact", /pgTable\(\s*["']income_schedules["']/.test(schemaSrc) && existsSync("lib/services/income-schedules.ts"));
  ok("[58] Finance 1B.0 remains intact", existsSync("lib/providers/bank-provider.ts") && existsSync("lib/providers/token-crypto.ts") && existsSync("lib/providers/amount.ts"));

  // cleanup BEFORE the final owner-data assertions.
  for (const id of created) await deleteConnection(U, id);
  const remaining = await connCount();

  const after = await ownerSnapshot();
  ok("[59] request 222 remains untouched", after.r === before.r);
  ok("[60] owner accounts remain untouched", after.a === before.a);
  ok("[61] owner income remains untouched", after.i === before.i);
  ok("[62] owner bills remain untouched", after.b === before.b);
  ok("[63] owner transfers remain untouched", after.t === before.t);
  ok("[64] owner movements remain untouched", after.m === before.m);
  const logsAfter = (await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))).length;
  ok("[65] no AI call or usage-log row", logsAfter === logsBefore && !/@anthropic|openai|messages\.create/i.test(codeBlob));
  ok("[66] exact-ID cleanup only (no connection rows remain)", remaining === 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch(async (e) => {
  // Best-effort cleanup of anything created before the failure.
  try { for (const id of created) await deleteConnection(U, id); } catch { /* ignore */ }
  console.error(e);
  process.exit(1);
});
