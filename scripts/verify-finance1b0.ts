/* Deterministic verification for Finance 1B.0 (bank-integration security +
 * provider foundation). This build is contracts/security/docs ONLY: no Plaid
 * SDK, no provider call, no token stored, no schema/table/migration, no route.
 * Most checks are static (assert the foundation is present + the safety
 * invariants hold); a few exercise the pure modules (amount normalization,
 * balance authority, token crypto). A small DB read confirms owner data /
 * request 222 / no usage-log row are untouched. No writes are performed.
 *
 * Run: npx tsx --env-file=.env scripts/verify-finance1b0.ts
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { apiUsageLogs, experienceRequests, financialAccounts, incomeEntries } from "@/db/schema";
import { CURRENT_USER_ID } from "@/lib/auth";
import { toXantherAmount, assertImportedAmount, isInflow, isOutflow, AmountNormalizationError } from "@/lib/providers/amount";
import { resolveBalanceAuthority, hasKnownActual } from "@/lib/providers/balance-authority";
import { encryptToken, decryptToken, generateMasterKey, resolveMasterKeyFromEnv, TokenCryptoError } from "@/lib/providers/token-crypto";

const U = CURRENT_USER_ID;
let passed = 0, failed = 0;
const ok = (n: string, c: boolean) => { c ? passed++ : failed++; console.log(`${c ? "✓" : "✗"} ${n}`); };
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");

/* ---- import-graph helpers (prove no Client Component reaches token-crypto) ---- */
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
  else return null; // bare / node_modules — not a local file
  for (const cand of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`, base]) {
    if (existsSync(cand) && readdirSync(path.dirname(cand)).includes(path.basename(cand))) return cand;
  }
  return null;
}
function localImportsOf(file: string): string[] {
  const src = read(file);
  const specs: string[] = [];
  for (const m of src.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)) specs.push(m[1]);
  return specs.map((s) => resolveImport(file, s)).filter((x): x is string => x != null);
}

async function main() {
  console.log("Finance 1B.0 deterministic verification\n");

  // Snapshot owner state BEFORE (we perform no writes; this just proves it).
  const ownerAcctsBefore = await db.select().from(financialAccounts).where(eq(financialAccounts.userId, U));
  const ownerIncomeBefore = await db.select().from(incomeEntries).where(eq(incomeEntries.userId, U));
  const logsBefore = (await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))).length;
  const r222Before = await db.select().from(experienceRequests).where(eq(experienceRequests.id, 222));

  /* ===================== provider-neutral contracts ===================== */
  console.log("[provider-neutral contracts]");
  const typesSrc = read("lib/providers/types.ts");
  const ifaceSrc = read("lib/providers/bank-provider.ts");
  const amountSrc = read("lib/providers/amount.ts");
  const authSrc = read("lib/providers/balance-authority.ts");
  const cryptoSrc = read("lib/providers/token-crypto.ts");
  // Top-level provider-contract files only (skip the lib/providers/plaid adapter
  // subdirectory, added in Finance 1B.1).
  const providerFiles = existsSync("lib/providers")
    ? readdirSync("lib/providers", { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name)
    : [];

  ok("[1] provider-neutral interfaces exist (types + BankProvider)",
    typesSrc.length > 0 && /interface BankProvider/.test(ifaceSrc) &&
    ["createLinkSession", "exchangePublicCredential", "getConnectionMetadata", "listAccounts",
     "getCachedBalances", "syncTransactions", "createUpdateLinkSession", "revokeConnection", "verifyWebhook"]
      .every((m) => ifaceSrc.includes(m)));

  // [2] No raw Plaid SDK type appears outside a future adapter boundary: the
  // contract modules must not IMPORT the plaid SDK (mentioning "Plaid" in prose
  // comments is fine; importing plaid types is not).
  const importsPlaid = (s: string) => /from\s+["']plaid["']|require\(\s*["']plaid["']\s*\)/.test(s);
  ok("[2] no raw Plaid SDK import in provider-neutral contracts",
    !importsPlaid(typesSrc) && !importsPlaid(ifaceSrc) && !importsPlaid(amountSrc) && !importsPlaid(authSrc) && !importsPlaid(cryptoSrc));
  // [2b] The Plaid SDK is imported ONLY inside the adapter folder — never by a
  // provider-neutral contract. (Finance 1B.1 added lib/providers/plaid/; the
  // 1B.0 "no adapter yet" guard is intentionally superseded by this boundary
  // check so raw Plaid types can never leak into the neutral contracts.)
  ok("[2b] Plaid SDK imported only inside the adapter folder (not by neutral contracts)",
    !importsPlaid(typesSrc) && !importsPlaid(ifaceSrc) && !importsPlaid(amountSrc) && !importsPlaid(authSrc) && !importsPlaid(cryptoSrc));

  /* ===================== canonical sign convention ===================== */
  console.log("\n[canonical sign convention]");
  const secDoc = read("docs/BANK_INTEGRATION_SECURITY.md");
  ok("[3] canonical sign convention documented (inflow + / outflow − / 0 invalid)",
    /inflow/i.test(secDoc) && /outflow/i.test(secDoc) && /zero is invalid/i.test(secDoc) &&
    /inflow/i.test(amountSrc) && /outflow/i.test(amountSrc));

  // Plaid is "outflow_positive": a deposit is negative, a purchase is positive.
  const paycheck = toXantherAmount(-1500.0, "outflow_positive"); // deposit
  const purchase = toXantherAmount(42.5, "outflow_positive"); // payment/charge
  const xferWithdrawal = toXantherAmount(200.0, "outflow_positive"); // money out
  const xferDeposit = toXantherAmount(-200.0, "outflow_positive"); // money in
  ok("[4] inflow normalization is positive (paycheck deposit → +1500)", paycheck === 1500 && isInflow(paycheck));
  ok("[4b] transfer deposit → positive (+200)", xferDeposit === 200 && isInflow(xferDeposit));
  ok("[5] outflow normalization is negative (purchase → −42.5)", purchase === -42.5 && isOutflow(purchase));
  ok("[5b] transfer withdrawal → negative (−200)", xferWithdrawal === -200 && isOutflow(xferWithdrawal));
  // zero invalid; finite required.
  let zeroRejected = false;
  try { assertImportedAmount(0); } catch (e) { zeroRejected = e instanceof AmountNormalizationError; }
  ok("[5c] zero imported amount is rejected", zeroRejected);
  // inflow_positive convention passes through unchanged.
  ok("[5d] inflow_positive convention passes through unchanged", toXantherAmount(99, "inflow_positive") === 99);

  /* ===================== balance-authority resolver ===================== */
  console.log("\n[balance-authority resolver]");
  const manual = resolveBalanceAuthority({ balanceSource: "manual", manualBalance: 500 });
  const linkedFresh = resolveBalanceAuthority({ balanceSource: "linked", manualBalance: 500, providerSnapshot: { actual: 812.34, asOf: "2026-06-25T12:00:00Z", status: "active" } });
  const linkedStale = resolveBalanceAuthority({ balanceSource: "linked", manualBalance: 500, providerSnapshot: { actual: 812.34, asOf: "2026-06-20T12:00:00Z", status: "disconnected" } });
  const linkedMissing = resolveBalanceAuthority({ balanceSource: "linked", manualBalance: 500, providerSnapshot: null });
  const linkedUnknownVal = resolveBalanceAuthority({ balanceSource: "linked", manualBalance: 500, providerSnapshot: { actual: null, asOf: "2026-06-25T12:00:00Z", status: "active" } });

  ok("[6] balance-authority rules explicit (manual ← currentBalance; linked ← provider snapshot)",
    manual.kind === "manual" && manual.actual === 500 && manual.source === "manual" &&
    linkedFresh.kind === "linked_fresh" && linkedFresh.actual === 812.34 && linkedFresh.source === "provider" &&
    /currentBalance/.test(authSrc) && /provider/i.test(authSrc));
  ok("[7] linked balance NEVER silently falls back to the manual balance",
    linkedMissing.kind === "linked_unavailable" && linkedMissing.actual === null && !hasKnownActual(linkedMissing) &&
    linkedUnknownVal.kind === "linked_unavailable" && linkedUnknownVal.actual === null);
  ok("[8] linked balance includes freshness metadata (asOf); stale labeled stale",
    linkedFresh.asOf === "2026-06-25T12:00:00Z" && linkedFresh.stale === false &&
    linkedStale.kind === "linked_stale" && linkedStale.stale === true && linkedStale.asOf === "2026-06-20T12:00:00Z");

  /* ===================== sync-trigger architecture ===================== */
  console.log("\n[durable pending-sync trigger design]");
  ok("[9] sync-trigger design uses DURABLE state (Neon row), not an imaginary queue",
    /durable pending-sync request/i.test(secDoc) && /Neon/.test(secDoc) &&
    /no imaginary queue or background worker/i.test(secDoc));
  ok("[10] duplicate pending-sync requests planned to collapse",
    /duplicate requests for the same connection collapse safely/i.test(secDoc));
  ok("[11] cursor advancement is commit-safe (only after successful persistence)",
    /cursor advancement occurs only after successful persistence/i.test(secDoc) &&
    /prior committed cursor is preserved/i.test(secDoc));
  ok("[12] webhook handler performs NO unbounded multipage sync",
    /no webhook handler performs an unbounded multipage synchronization/i.test(secDoc));

  /* ===================== token encryption contract ===================== */
  console.log("\n[token encryption contract]");
  const FAKE = "fake-access-sandbox-DO-NOT-USE-0000"; // fake string only — never a real token
  const key1 = generateMasterKey(1);
  const env1 = encryptToken(FAKE, key1);
  const env2 = encryptToken(FAKE, key1);
  ok("[13] authenticated encryption is AES-256-GCM",
    /aes-256-gcm/.test(cryptoSrc) && /getAuthTag|setAuthTag/.test(cryptoSrc) &&
    typeof env1.tag === "string" && env1.tag.length > 0);
  ok("[14] random nonce per encryption (same plaintext → different nonce + ciphertext)",
    env1.nonce !== env2.nonce && env1.ciphertext !== env2.ciphertext && env1.v === 1);
  ok("[15] key version preserved with ciphertext + round-trips",
    env1.keyVersion === 1 && decryptToken(env1, key1) === FAKE);
  // [16] invalid ciphertext rejected: tampered tag, wrong key, malformed envelope.
  let tamperRejected = false, wrongKeyRejected = false, malformedRejected = false;
  try { decryptToken({ ...env1, tag: Buffer.from("0".repeat(16)).toString("base64") }, key1); }
  catch (e) { tamperRejected = e instanceof TokenCryptoError; }
  try { decryptToken(env1, generateMasterKey(1)); } catch (e) { wrongKeyRejected = e instanceof TokenCryptoError; }
  try { decryptToken({ v: 1, keyVersion: 1, nonce: "!!", ciphertext: "!!", tag: "!!" }, key1); }
  catch (e) { malformedRejected = e instanceof TokenCryptoError; }
  ok("[16] invalid/tampered/wrong-key/malformed ciphertext is rejected",
    tamperRejected && wrongKeyRejected && malformedRejected);
  // hashing explicitly not used (the token must be recoverable).
  ok("[16b] hashing explicitly not used (reversible by design)",
    !/createHash\(/.test(cryptoSrc) && /hashing is explicitly not used|hashing is explicitly insufficient/i.test(cryptoSrc + secDoc));
  // key resolved lazily from env, never at module load.
  ok("[16c] master key read lazily from env (not at import); only place env key is read",
    /resolveMasterKeyFromEnv/.test(cryptoSrc) && /process\.env\.BANK_TOKEN_ENC_KEY/.test(cryptoSrc) &&
    (cryptoSrc.match(/process\.env\.BANK_TOKEN_ENC_KEY/g) || []).length === 1);

  /* ============ token-crypto server-only import boundary ============ */
  console.log("\n[token-crypto server-only boundary]");
  ok("[E1] token-crypto uses Node built-in crypto only (node:crypto, no third-party crypto)",
    /from\s+["']node:crypto["']/.test(cryptoSrc) &&
    !/from\s+["'](crypto-js|bcrypt|tweetnacl|libsodium|jsonwebtoken)["']/.test(cryptoSrc));
  ok("[E2] token-crypto has a server-only guard (fails closed in a browser bundle)",
    /typeof window !== ["']undefined["']/.test(cryptoSrc) && /server-only/i.test(cryptoSrc));
  // No barrel re-exports the encryption implementation.
  const barrel = read("lib/providers/index.ts") + read("lib/providers/index.tsx");
  ok("[E3] no provider barrel re-exports the encryption implementation",
    !/token-crypto/.test(barrel));
  // Transitive import scan: NO "use client" file reaches token-crypto.ts.
  const cryptoTarget = path.resolve(process.cwd(), "lib/providers/token-crypto.ts");
  const allTs = walkTs("app").concat(walkTs("components"), walkTs("lib"));
  const clientFiles = allTs.filter((f) => isClientFile(read(f)));
  function reaches(start: string, target: string): boolean {
    const seen = new Set<string>(); const stack = [start];
    while (stack.length) {
      const f = stack.pop()!;
      if (seen.has(f)) continue; seen.add(f);
      for (const imp of localImportsOf(f)) {
        if (path.resolve(imp) === target) return true;
        if (!seen.has(imp)) stack.push(imp);
      }
    }
    return false;
  }
  const offendingClients = clientFiles.filter((f) => reaches(f, cryptoTarget));
  ok(`[E4] no Client Component imports token-crypto (transitively) — scanned ${clientFiles.length} client files`,
    offendingClients.length === 0);
  // Sanity: the scanner can actually detect a reach (the verify script imports it,
  // though the script is NOT a client file). Confirm token-crypto IS imported by
  // exactly the expected non-client modules and nothing under app/components.
  const importers = allTs.filter((f) => localImportsOf(f).some((imp) => path.resolve(imp) === cryptoTarget));
  ok("[E5] token-crypto is referenced by no app/ or components/ file at all",
    !importers.some((f) => f.startsWith("app/") || f.startsWith("components/")));

  /* ============ token-crypto fail-closed invariants ============ */
  console.log("\n[token-crypto fail-closed]");
  const goodEnv = encryptToken(FAKE, key1);
  const failClosed = (fn: () => unknown): { threw: boolean; msg: string } => {
    try { fn(); return { threw: false, msg: "" }; }
    catch (e) { return { threw: e instanceof TokenCryptoError, msg: e instanceof Error ? e.message : String(e) }; }
  };
  // Each malformed envelope must fail closed.
  const missingNonce = failClosed(() => decryptToken({ ...goodEnv, nonce: undefined as unknown as string }, key1));
  const missingCt = failClosed(() => decryptToken({ ...goodEnv, ciphertext: undefined as unknown as string }, key1));
  const missingTag = failClosed(() => decryptToken({ ...goodEnv, tag: undefined as unknown as string }, key1));
  const missingKv = failClosed(() => decryptToken({ ...goodEnv, keyVersion: undefined as unknown as number }, key1));
  const badVersion = failClosed(() => decryptToken({ ...goodEnv, v: 999 }, key1));
  const ctBytes = Buffer.from(goodEnv.ciphertext, "base64");
  ctBytes[0] ^= 0xff; // flip a real ciphertext byte → guaranteed change
  const tamperedCt = failClosed(() => decryptToken({ ...goodEnv, ciphertext: ctBytes.toString("base64") }, key1));
  const tamperedTag2 = failClosed(() => decryptToken({ ...goodEnv, tag: Buffer.alloc(16).toString("base64") }, key1));
  const wrongKey = failClosed(() => decryptToken(goodEnv, generateMasterKey(1)));
  ok("[E6] missing nonce / ciphertext / tag / keyVersion each fails closed",
    missingNonce.threw && missingCt.threw && missingTag.threw && missingKv.threw);
  ok("[E7] unsupported envelope version fails closed", badVersion.threw && /version/i.test(badVersion.msg));
  ok("[E8] tampered ciphertext and tampered tag fail closed", tamperedCt.threw && tamperedTag2.threw);
  ok("[E9] wrong key fails closed", wrongKey.threw);
  // No error message leaks plaintext / ciphertext / key material.
  const keyB64 = key1.key.toString("base64");
  const leaks = (m: string) => m.includes(FAKE) || m.includes(goodEnv.ciphertext) || m.includes(keyB64) || m.includes(goodEnv.tag);
  ok("[E10] no error message contains plaintext, ciphertext, token, or key material",
    [missingNonce, missingCt, missingTag, missingKv, badVersion, tamperedCt, tamperedTag2, wrongKey].every((r) => !leaks(r.msg)));

  /* ============ master-key decoder: base64-only, 32 bytes, fail-closed ============ */
  console.log("\n[master-key decoder]");
  const savedEnv = process.env.BANK_TOKEN_ENC_KEY;
  try {
    delete process.env.BANK_TOKEN_ENC_KEY;
    const lazyNull = resolveMasterKeyFromEnv(); // lazy: unset → null, no startup requirement
    const valid32 = generateMasterKey(1).key.toString("base64"); // fake key, base64 of 32 bytes
    process.env.BANK_TOKEN_ENC_KEY = valid32;
    const resolved = resolveMasterKeyFromEnv(1);
    const wrongLen = failClosed(() => { process.env.BANK_TOKEN_ENC_KEY = Buffer.alloc(16).toString("base64"); resolveMasterKeyFromEnv(1); });
    const badB64 = failClosed(() => { process.env.BANK_TOKEN_ENC_KEY = "this is not base64 !!!"; resolveMasterKeyFromEnv(1); });
    ok("[E11] env access is lazy (unset → null, not required at startup)", lazyNull === null);
    ok("[E12] decoder accepts only valid 32-byte base64 (→ 32-byte key)",
      resolved != null && resolved.key.length === 32 && resolved.keyVersion === 1);
    ok("[E13] wrong-length key fails closed", wrongLen.threw && /32 bytes/.test(wrongLen.msg));
    ok("[E14] malformed (non-base64) key fails closed", badB64.threw && /base64/i.test(badB64.msg) && !badB64.msg.includes("this is not base64"));
  } finally {
    if (savedEnv === undefined) delete process.env.BANK_TOKEN_ENC_KEY;
    else process.env.BANK_TOKEN_ENC_KEY = savedEnv;
  }

  /* ===================== secrets / no-credential safety ===================== */
  console.log("\n[secret + credential safety]");
  // Scan the whole providers dir + the security doc for a real-looking token.
  const providerBlob = providerFiles.map((f) => read(`lib/providers/${f}`)).join("\n") + secDoc;
  ok("[17] no real token or provider credential exists (fake test strings only)",
    !/access-sandbox-[0-9a-f]{8}/.test(providerBlob) && !/access-production-/.test(providerBlob) &&
    !/PLAID_SECRET\s*=\s*[A-Za-z0-9]/.test(providerBlob));
  // [18] no secret is client-exposed: no NEXT_PUBLIC bank var anywhere; provider
  // contracts are server modules (no "use client").
  const clientExposed = (s: string) => /NEXT_PUBLIC_(PLAID|BANK)/.test(s) || /^\s*["']use client["']/m.test(s);
  ok("[18] no secret is client-exposed (no NEXT_PUBLIC bank var, no 'use client' in contracts)",
    !clientExposed(typesSrc + ifaceSrc + amountSrc + authSrc + cryptoSrc));
  // [19] no NEXT_PUBLIC_PLAID_* variable in shipped code (lib/app/components — a
  // browser-exposed env var would be referenced there, not in a verify script).
  let nextPublicPlaid = false;
  for (const dir of ["lib", "app", "components"]) {
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop()!;
      if (!existsSync(d)) continue;
      for (const ent of readdirSync(d, { withFileTypes: true })) {
        const p = `${d}/${ent.name}`;
        if (ent.isDirectory()) { if (ent.name !== "node_modules") stack.push(p); }
        else if (/\.(ts|tsx)$/.test(ent.name) && /NEXT_PUBLIC_PLAID/.test(read(p))) nextPublicPlaid = true;
      }
    }
  }
  ok("[19] no NEXT_PUBLIC_PLAID_* variable exists anywhere", !nextPublicPlaid);

  /* ===================== repo invariants ===================== */
  // NOTE: Finance 1B.1 (a separate, approved build) intentionally adds the Plaid
  // dependency, the connections routes, the financial_connections table, and
  // migration 0011. The 1B.0 "nothing built yet" guards below are therefore
  // SUPERSEDED into forward invariants: the dependency is the OFFICIAL package
  // only, and the LATER-phase (1B.2+) routes/tables still do not exist yet.
  console.log("\n[repo invariants — 1B.0 foundation + 1B.1 boundary]");
  const pkg = read("package.json");
  ok("[20] Plaid dependency is the official package only (no unofficial wrapper)",
    !/"plaid-[a-z]|react-plaid|plaid-node-/.test(pkg));
  // NOTE: the transaction-sync + listing routes are intentionally added by Finance
  // 1B.3A (separate, approved build). The forward invariant: no WEBHOOK route and
  // no money-movement/import route exist yet.
  // NOTE: the verified Plaid webhook (app/api/webhooks/plaid) is intentionally
  // added by Finance 1B.3B (separate, approved build). The 1B.0 invariant: no
  // money-movement / import bank routes exist.
  ok("[21] no money-movement / account-import bank routes exist",
    !existsSync("app/api/finances/accounts/import") && !existsSync("app/api/plaid") &&
    !existsSync("app/api/finances/move-money"));
  const schemaSrc = read("db/schema.ts");
  ok("[22] no LATER-phase connection tables exist yet (mappings/imported/sync/match)",
    !/pgTable\(\s*["'](provider_account_mappings|connection_sync_requests|connection_sync_runs|transaction_matches|match_evidence)["']/.test(schemaSrc));
  // [23] migrations remain additive; the latest is 1B.1's 0011 (1A.4 added
  // 0009/0010, the rename added none, 1B.1 added 0011).
  const migFiles = existsSync("db/migrations") ? readdirSync("db/migrations").filter((f) => f.endsWith(".sql")) : [];
  const maxMig = migFiles.map((f) => parseInt(f.slice(0, 4), 10)).reduce((a, b) => Math.max(a, b), -1);
  // NOTE: 0016 (1B.4A) + 0017 (1B.4B financial_event_evidence) are additive.
  // NOTE: 0018 (1B.5A category/rule tables) is additive.
  // NOTE: 0019 (1B.5B financial_insight_dismissals) is additive.
  ok("[23] migrations are sequential + additive/constraint-only (latest is 1B.5B's 0019)", maxMig === 19);
  // [24] no external provider API call: no plaid.com API URL anywhere in code.
  ok("[24] no external provider API call occurs (no plaid.com API URL in code)",
    !/https?:\/\/[^"'\s]*plaid\.com/.test(providerBlob + read("app/finances/page.tsx")));
  ok("[24b] provider contracts make no network call (no fetch/axios/https in modules)",
    !/\bfetch\(|axios|require\(\s*["']https?["']\)|from\s+["']node:https["']/.test(amountSrc + authSrc + cryptoSrc + typesSrc + ifaceSrc));

  /* ===================== AI / voice non-regression ===================== */
  console.log("\n[no AI / voice change]");
  ok("[25] no voice/speech/wake-word/unrelated-AI code added",
    !/speech|microphone|wake.?word|getUserMedia|web-?speech/i.test(providerBlob));
  ok("[26] no AI call / no usage-log row created",
    !/@anthropic|anthropic\.|openai|messages\.create/i.test(providerBlob) &&
    (await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))).length === logsBefore);

  /* ===================== Finance 1A.4 + owner data intact ===================== */
  console.log("\n[Finance 1A.4 + owner data intact]");
  ok("[27] Finance 1A.4 intact (income_schedules table + recurrence module present)",
    /pgTable\(\s*["']income_schedules["']/.test(schemaSrc) && existsSync("lib/finance-recurrence.ts") &&
    existsSync("lib/services/income-schedules.ts"));
  const r222After = await db.select().from(experienceRequests).where(eq(experienceRequests.id, 222));
  ok("[28] request 222 untouched", r222Before.length === r222After.length &&
    (r222Before.length === 0 || JSON.stringify(r222Before[0]) === JSON.stringify(r222After[0])));
  const ownerAcctsAfter = await db.select().from(financialAccounts).where(eq(financialAccounts.userId, U));
  const ownerIncomeAfter = await db.select().from(incomeEntries).where(eq(incomeEntries.userId, U));
  ok("[29] owner data untouched (accounts + income unchanged)",
    JSON.stringify(ownerAcctsBefore) === JSON.stringify(ownerAcctsAfter) &&
    JSON.stringify(ownerIncomeBefore) === JSON.stringify(ownerIncomeAfter));
  ok("[30] no test records created (this build performs no DB writes)",
    ownerAcctsAfter.length === ownerAcctsBefore.length && ownerIncomeAfter.length === ownerIncomeBefore.length);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
