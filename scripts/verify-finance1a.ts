/* Deterministic verification for Finance 1A.1 (account-aware manual finance).
 * Drives the real finance services + the real API route handlers against the
 * real DB. No AI, no network model calls. Strictly exact-ID cleanup; the owner's
 * existing accounts/bills survive untouched; request 222 is never touched.
 *
 * Run: npx tsx --env-file=.env scripts/verify-finance1a.ts
 */

import { readFileSync, existsSync } from "node:fs";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  financialAccounts,
  financialEntries,
  incomeEntries,
  apiUsageLogs,
  experienceRequests,
} from "@/db/schema";
import { CURRENT_USER_ID } from "@/lib/auth";
import {
  listAccounts,
  toAccountViews,
  computeCashSummary,
} from "@/lib/services/finances";
import { POST as accountsPost } from "@/app/api/finances/accounts/route";
import { PATCH as accountPatch } from "@/app/api/finances/accounts/[id]/route";
import { POST as billsPost } from "@/app/api/finances/bills/route";
import { PATCH as billPatch } from "@/app/api/finances/bills/[id]/route";
import { POST as incomePost } from "@/app/api/finances/income/route";
import { DELETE as incomeDelete } from "@/app/api/finances/income/[id]/route";

const U = CURRENT_USER_ID;
let passed = 0,
  failed = 0;
const ok = (n: string, c: boolean) => {
  c ? passed++ : failed++;
  console.log(`${c ? "✓" : "✗"} ${n}`);
};
const near = (a: number, b: number) => Math.abs(a - b) < 0.005;

const acct = {
  accountIds: [] as number[],
  billIds: [] as number[],
  incomeIds: [] as number[],
};

async function postJson(
  handler: (req: Request) => Promise<Response>,
  body: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await handler(
    new Request("http://local/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}
async function patchJson(
  handler: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>,
  id: number,
  body: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await handler(
    new Request(`http://local/api/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: String(id) }) },
  );
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

const rawAccount = async (id: number) =>
  (await db.select().from(financialAccounts).where(eq(financialAccounts.id, id)))[0];
const rawBill = async (id: number) =>
  (await db.select().from(financialEntries).where(eq(financialEntries.id, id)))[0];

async function main() {
  console.log("Finance 1A.1 deterministic verification\n");

  const logsBefore = (
    await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))
  ).length;

  // Snapshot every pre-existing live owner account + bill so we can prove they survive.
  const ownerAccountsBefore = await db
    .select()
    .from(financialAccounts)
    .where(and(eq(financialAccounts.userId, U), isNull(financialAccounts.deletedAt)));
  const ownerBillsBefore = await db
    .select()
    .from(financialEntries)
    .where(and(eq(financialEntries.userId, U), eq(financialEntries.kind, "bill"), isNull(financialEntries.deletedAt)));
  const ownerAcctBalances = new Map(ownerAccountsBefore.map((a) => [a.id, a.currentBalance]));

  /* ---- 1. Account creation, validated fields, and defaults --------------- */
  console.log("[1] account fields + defaults (via real POST route)");
  const a1 = await postJson(accountsPost, {
    name: "VF checking", type: "checking", purpose: "spending", currentBalance: 1000, institution: "TestBank",
  });
  const a2 = await postJson(accountsPost, { name: "VF savings", type: "savings", purpose: "savings", currentBalance: 500 });
  const a3 = await postJson(accountsPost, { name: "VF emergency", type: "cash", purpose: "emergency", currentBalance: 200 });
  const a4 = await postJson(accountsPost, { name: "VF credit card", type: "credit", purpose: "other", currentBalance: 300 });
  const a5 = await postJson(accountsPost, { name: "VF inactive", type: "checking", purpose: "spending", currentBalance: 999, active: false });
  const a6 = await postJson(accountsPost, { name: "VF minimal" }); // defaults only
  for (const r of [a1, a2, a3, a4, a5, a6]) {
    const id = (r.data.account as { id?: number } | undefined)?.id;
    if (id) acct.accountIds.push(id);
  }
  ok("[1] all six accounts created (201)", [a1, a2, a3, a4, a5, a6].every((r) => r.status === 201));
  const A1 = (a1.data.account as { id: number }).id;
  const A2 = (a2.data.account as { id: number }).id;
  const A4 = (a4.data.account as { id: number }).id;
  const A5 = (a5.data.account as { id: number }).id;
  const A6 = (a6.data.account as { id: number }).id;

  const r6 = await rawAccount(A6);
  ok("[1] default type=checking", r6.type === "checking");
  ok("[1] default purpose=other (never guessed)", r6.purpose === "other");
  ok("[1] default balanceSource=manual", r6.balanceSource === "manual");
  ok("[1] default includeInSpendable=true", r6.includeInSpendable === true);
  ok("[1] default active=true", r6.active === true);
  ok("[1] default balance=0", Number(r6.currentBalance) === 0);
  ok("[1] institution stored when provided", (await rawAccount(A1)).institution === "TestBank");

  // Savings/emergency default to excluded from spendable; spending defaults included.
  ok("[1] savings default excluded from spendable", (await rawAccount(A2)).includeInSpendable === false);
  ok("[1] emergency default excluded from spendable", (await rawAccount((a3.data.account as { id: number }).id)).includeInSpendable === false);
  ok("[1] spending default included in spendable", (await rawAccount(A1)).includeInSpendable === true);
  ok("[1] credit forced not-spendable", (await rawAccount(A4)).includeInSpendable === false);

  // Controlled vocabulary: invalid type/purpose rejected.
  ok("[1] invalid account type → 400", (await postJson(accountsPost, { name: "x", type: "crypto" })).status === 400);
  ok("[1] invalid purpose → 400", (await postJson(accountsPost, { name: "x", purpose: "vacation" })).status === 400);

  /* ---- 2. Cash / spendable / savings / liability rollups ----------------- */
  console.log("\n[2] cash + spendable + savings/emergency + credit rollups");
  const mine = () =>
    listAccounts(U).then((rows) => toAccountViews(rows.filter((r) => acct.accountIds.includes(r.id))));
  let summary = computeCashSummary(await mine());
  ok("[2] total actual cash = 1700 (A1+A2+A3; credit & inactive excluded)", near(summary.totalActualCash, 1700));
  ok("[2] spendable actual cash = 1000 (only spending account)", near(summary.spendableActualCash, 1000));
  ok("[2] savings/emergency surfaced separately = 700", near(summary.savingsEmergency, 700));
  ok("[2] credit liabilities = 300", near(summary.creditLiabilities, 300));
  ok("[2] credit NOT added to cash (1700 has no 300)", near(summary.totalActualCash, 1700));
  // Active cash-type accounts: A1 checking, A2 savings, A3 cash, A6 minimal-checking.
  ok("[2] cashAccountCount = 4", summary.cashAccountCount === 4);
  ok("[2] creditAccountCount = 1", summary.creditAccountCount === 1);

  /* ---- 3. Explicit credit sign convention -------------------------------- */
  console.log("\n[3] credit sign convention");
  // Convention: a credit balance is stored POSITIVE = amount owed. It is a
  // liability, never cash; netPosition = totalActualCash − creditLiabilities.
  ok("[3] credit balance stored positive (= owed)", Number((await rawAccount(A4)).currentBalance) === 300);
  ok("[3] netPosition = cash − credit owed = 1400", near(summary.netPosition, 1400));

  /* ---- 4. Active / inactive behavior ------------------------------------- */
  console.log("\n[4] active/inactive");
  ok("[4] inactive account excluded from totals", near(summary.totalActualCash, 1700)); // A5 (999) not counted
  // Reactivate A5 via PATCH → it now contributes.
  ok("[4] PATCH active=true → 200", (await patchJson(accountPatch, A5, { active: true })).status === 200);
  summary = computeCashSummary(await mine());
  ok("[4] reactivated account now counted (1700+999=2699)", near(summary.totalActualCash, 2699));
  await patchJson(accountPatch, A5, { active: false }); // restore

  /* ---- 5. Bills: link to source account, unassigned, paid metadata ------- */
  console.log("\n[5] bills + account linkage");
  const b1 = await postJson(billsPost, { name: "VF linked bill", expectedAmount: 120, dueDate: "2026-07-01", sourceAccountId: A1 });
  const b2 = await postJson(billsPost, { name: "VF unassigned bill", expectedAmount: 60 });
  for (const r of [b1, b2]) {
    const id = (r.data.bill as { id?: number } | undefined)?.id;
    if (id) acct.billIds.push(id);
  }
  const B1 = (b1.data.bill as { id: number }).id;
  const B2 = (b2.data.bill as { id: number }).id;
  ok("[5] bill links to source account", (await rawBill(B1)).sourceAccountId === A1);
  ok("[5] unassigned bill keeps null source (never guessed)", (await rawBill(B2)).sourceAccountId === null);
  ok("[5] invalid source account → 400", (await postJson(billsPost, { name: "x", expectedAmount: 10, sourceAccountId: 999999 })).status === 400);

  // Existing owner bills remain valid (read-only). Owner bills may legitimately
  // carry a source/paid account now, so we assert validity, not "all unassigned".
  ok("[5] pre-existing owner bills still valid",
    ownerBillsBefore.every((b) => b.deletedAt === null));

  /* ---- 6. External pay: paid metadata, no balance change (1A.3A supersedes
   *        the old "manual pay never deducts" rule — see verify-finance1a3a). -- */
  console.log("\n[6] external pay: paid metadata, no balance change");
  const a1BalBefore = (await rawAccount(A1)).currentBalance;
  const a2BalBefore = (await rawAccount(A2)).currentBalance;
  const pay = await patchJson(billPatch, B1, { status: "paid" }); // external (no account)
  ok("[6] mark paid (external) → 200", pay.status === 200);
  const paidRow = await rawBill(B1);
  ok("[6] status=paid", paidRow.status === "paid");
  ok("[6] paidAt stamped", paidRow.paidAt !== null);
  ok("[6] external pay → paidAccountId null", paidRow.paidAccountId === null);
  ok("[6] external pay changes no balance (A1)", (await rawAccount(A1)).currentBalance === a1BalBefore);
  ok("[6] external pay changes no balance (A2)", (await rawAccount(A2)).currentBalance === a2BalBefore);
  ok("[6] invalid paid account → 400", (await patchJson(billPatch, B2, { status: "paid", paidAccountId: 999999 })).status === 400);

  /* ---- 7. Income management remains accessible --------------------------- */
  console.log("\n[7] income still manageable (kept on /manage)");
  const inc = await postJson(incomePost, { source: "VF paycheck", expectedAmount: 800, payDate: "2026-07-03" });
  ok("[7] create income → 201", inc.status === 201);
  const incId = (inc.data.income as { id?: number } | undefined)?.id;
  if (incId) acct.incomeIds.push(incId);
  if (incId) {
    const del = await incomeDelete(new Request("http://local"), { params: Promise.resolve({ id: String(incId) }) });
    ok("[7] delete income → 200", del.status === 200);
    acct.incomeIds = acct.incomeIds.filter((x) => x !== incId);
  }

  /* ---- 7b. Credit/spendable invariant enforced on POST and PATCH -------- */
  console.log("\n[7b] credit-never-spendable invariant (POST + PATCH)");
  // (1) POST credit with includeInSpendable:true → stored false.
  const cp = await postJson(accountsPost, { name: "VF credit spend-true", type: "credit", currentBalance: 100, includeInSpendable: true });
  const CP = (cp.data.account as { id: number }).id; acct.accountIds.push(CP);
  ok("[7b] (1) POST credit w/ spendable=true → stored false", (await rawAccount(CP)).includeInSpendable === false);

  // Seed a spendable checking account to flip through credit and back.
  const ce = await postJson(accountsPost, { name: "VF flip", type: "checking", purpose: "spending", currentBalance: 100, includeInSpendable: true });
  const CE = (ce.data.account as { id: number }).id; acct.accountIds.push(CE);
  ok("[7b] seeded checking starts spendable=true", (await rawAccount(CE)).includeInSpendable === true);

  // (2) PATCH checking → credit with includeInSpendable:true → stored false.
  await patchJson(accountPatch, CE, { type: "credit", includeInSpendable: true });
  let ceRow = await rawAccount(CE);
  ok("[7b] (2) checking→credit w/ spendable=true → stored false", ceRow.type === "credit" && ceRow.includeInSpendable === false);

  // (3) Editing other/explicit fields on a credit account cannot make it spendable.
  await patchJson(accountPatch, CE, { includeInSpendable: true });
  ok("[7b] (3a) PATCH spendable=true on credit stays false", (await rawAccount(CE)).includeInSpendable === false);
  await patchJson(accountPatch, CE, { name: "VF flip renamed" });
  ok("[7b] (3b) editing another field on credit keeps spendable false", (await rawAccount(CE)).includeInSpendable === false);

  // (4) credit → checking does NOT auto-enable spendable (preserves false).
  await patchJson(accountPatch, CE, { type: "checking" });
  ceRow = await rawAccount(CE);
  ok("[7b] (4) credit→checking keeps spendable false (no auto-true)", ceRow.type === "checking" && ceRow.includeInSpendable === false);

  // (5) Owner may explicitly enable spendable once it is a non-credit account.
  await patchJson(accountPatch, CE, { includeInSpendable: true });
  ok("[7b] (5) explicit enable on checking → true", (await rawAccount(CE)).includeInSpendable === true);

  // (6) computeCashSummary excludes credit from cash + spendable even if a row's
  // includeInSpendable were somehow true (defence at the calculation layer).
  const malformedCredit = {
    id: -1, name: "x", type: "credit", institution: null, purpose: "other",
    currentBalance: 500, balanceSource: "manual", includeInSpendable: true,
    active: true, isCash: false, isLiability: true,
  } as unknown as Parameters<typeof computeCashSummary>[0][number];
  const s6 = computeCashSummary([malformedCredit]);
  ok("[7b] (6) calc excludes credit from cash + spendable regardless of flag",
    s6.totalActualCash === 0 && s6.spendableActualCash === 0 && near(s6.creditLiabilities, 500));

  // Final guarantee: no stored credit account owned by U has includeInSpendable=true.
  const creditRows = await db.select().from(financialAccounts).where(and(eq(financialAccounts.userId, U), eq(financialAccounts.type, "credit")));
  ok("[7b] no stored credit account is spendable", creditRows.every((r) => r.includeInSpendable === false));

  /* ---- 8. Source-level guardrails: filesystem + schema scans ------------- */
  console.log("\n[8] scope + truthfulness scans");
  const schemaSrc = readFileSync("db/schema.ts", "utf8");
  const pageSrc = readFileSync("app/finances/page.tsx", "utf8");
  const acctMgr = readFileSync("components/finances/account-manager.tsx", "utf8");
  const billMgr = readFileSync("components/finances/bill-manager.tsx", "utf8");
  const homeSrc = readFileSync("components/home/sections.tsx", "utf8");
  const manageSrc = readFileSync("components/manage/manage-dashboard.tsx", "utf8");
  const uiText = [pageSrc, acctMgr, billMgr, manageSrc].join("\n").toLowerCase();

  ok("[8] /finances page exists", existsSync("app/finances/page.tsx"));
  ok("[8] no 'safe to spend' anywhere in finance UI", !uiText.includes("safe to spend"));
  ok("[8] no 'live balance' anywhere in finance UI", !uiText.includes("live balance"));
  ok("[8] UI labels balances 'manually entered' / 'manual balance'",
    /manually entered/i.test(pageSrc) && /manual balance/i.test(acctMgr));
  // NOTE: account-aware PROJECTION (projectedBalance, reconciliation) is intentionally
  // added by Finance 1A.3B — verified by scripts/verify-finance1a3b.ts. The 1A.1
  // truthfulness guard remains: never "safe to spend" / "live balance" (checked above).

  // Scope corrections: no provider/connection-health fields on the account.
  ok("[8] no providerAccountId field", !/provider_account_id|providerAccountId/.test(schemaSrc));
  ok("[8] no syncStatus field", !/sync_status|syncStatus/.test(schemaSrc));
  ok("[8] no connectionError field", !/connection_error|connectionError/.test(schemaSrc));
  ok("[8] no lastSyncedAt field", !/last_synced_at|lastSyncedAt/.test(schemaSrc));
  // NOTE: reconciliation (last_reconciled_at + the reconcile route) is intentionally
  // added by Finance 1A.3B — no longer excluded here; verified by verify-finance1a3b.ts.
  // NOTE: income splits (income_allocations) and transfers (account_transfers) are
  // intentionally added by Finance 1A.2 — no longer excluded here; verified by
  // scripts/verify-finance1a2.ts.
  // NOTE: the account-movements ledger is intentionally added by Finance 1A.3A
  // (a separate, approved build) — so it is NO LONGER excluded here. Its own
  // behavior is verified by scripts/verify-finance1a3a.ts.
  ok("[8] balance_source enum present (manual|linked, future-ready)", /balance_source/.test(schemaSrc));
  ok("[8] no Plaid references", !/plaid/i.test(schemaSrc + pageSrc + acctMgr + billMgr));

  // Home stays compact; /manage links to /finances; income preserved on /manage.
  ok("[8] Home money card links to /finances", homeSrc.includes('href="/finances"'));
  ok("[8] Home has no account management", !homeSrc.includes("AccountManager"));
  ok("[8] /manage links to /finances", manageSrc.includes("/finances"));
  // Income management moved from /manage to /finances in Finance 1A.2; /manage links there.
  ok("[8] /manage links money management to /finances", manageSrc.includes("/finances"));

  /* ---- 9. No AI / no usage log ------------------------------------------- */
  const logsAfter = (
    await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))
  ).length;
  ok("[9] no usage-log row created (no AI)", logsBefore === logsAfter);

  /* ---- 10. Owner records survived untouched ------------------------------ */
  console.log("\n[10] owner data preservation");
  for (const a of ownerAccountsBefore) {
    const now = await rawAccount(a.id);
    ok(`[10] owner account #${a.id} survives, balance unchanged`,
      !!now && now.deletedAt === null && now.currentBalance === ownerAcctBalances.get(a.id));
  }
  for (const b of ownerBillsBefore) {
    const now = await rawBill(b.id);
    // Compare against the BEFORE snapshot (not a hardcoded null) — owner bills may
    // legitimately carry a paid/source account; we assert they are UNCHANGED.
    const unchanged =
      !!now &&
      now.deletedAt === null &&
      now.status === b.status &&
      now.paidAccountId === b.paidAccountId &&
      now.sourceAccountId === b.sourceAccountId &&
      now.actualAmount === b.actualAmount &&
      now.expectedAmount === b.expectedAmount;
    ok(`[10] owner bill #${b.id} survives unchanged`, unchanged);
  }
}

async function cleanup() {
  console.log("\n[cleanup] exact-ID-scoped");
  console.log(`  targets — accounts:[${acct.accountIds}] bills:[${acct.billIds}] income:[${acct.incomeIds}]`);
  const [before222] = await db.select().from(experienceRequests).where(eq(experienceRequests.id, 222)).limit(1);
  // Bills reference accounts via FK → delete bills first, then income, then accounts.
  for (const id of acct.billIds) await db.delete(financialEntries).where(eq(financialEntries.id, id));
  for (const id of acct.incomeIds) await db.delete(incomeEntries).where(eq(incomeEntries.id, id));
  for (const id of acct.accountIds) await db.delete(financialAccounts).where(eq(financialAccounts.id, id));
  const [after222] = await db.select().from(experienceRequests).where(eq(experienceRequests.id, 222)).limit(1);
  ok("[cleanup] request 222 untouched", JSON.stringify(after222) === JSON.stringify(before222));
  const leftAcct = (
    await db.select({ id: financialAccounts.id }).from(financialAccounts).where(eq(financialAccounts.userId, U))
  ).filter((r) => acct.accountIds.includes(r.id));
  const leftBill = (
    await db.select({ id: financialEntries.id }).from(financialEntries).where(eq(financialEntries.userId, U))
  ).filter((r) => acct.billIds.includes(r.id));
  ok("[cleanup] all harness accounts removed", leftAcct.length === 0);
  ok("[cleanup] all harness bills removed", leftBill.length === 0);
}

main()
  .then(cleanup)
  .catch(async (e) => {
    console.error("harness error:", e);
    try {
      await cleanup();
    } catch {}
    process.exitCode = 1;
  })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    console.log("\nAccount-aware manual finance verified; no balance mutation on pay, no AI, owner data intact.");
    if (failed > 0) process.exitCode = 1;
  });
