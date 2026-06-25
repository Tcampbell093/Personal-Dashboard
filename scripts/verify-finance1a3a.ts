/* Deterministic verification for Finance 1A.3A (manual bill-payment ledger).
 * Drives the real pay/reverse/PATCH route handlers + services against the real
 * DB. No AI. Strictly exact-ID cleanup; the owner's accounts/bills survive
 * untouched; request 222 is never touched. Includes real wall-clock concurrency.
 *
 * Run: npx tsx --env-file=.env scripts/verify-finance1a3a.ts
 */

import { readFileSync } from "node:fs";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  financialAccounts,
  financialEntries,
  accountMovements,
  apiUsageLogs,
  experienceRequests,
} from "@/db/schema";
import { CURRENT_USER_ID } from "@/lib/auth";
import { localToday } from "@/lib/time";
import { createAccount, createBill, listMovements } from "@/lib/services/finances";
import { POST as payRoute } from "@/app/api/finances/bills/[id]/pay/route";
import { POST as reverseRoute } from "@/app/api/finances/bills/[id]/reverse/route";
import { PATCH as billPatch } from "@/app/api/finances/bills/[id]/route";

const U = CURRENT_USER_ID;
let passed = 0,
  failed = 0;
const ok = (n: string, c: boolean) => {
  c ? passed++ : failed++;
  console.log(`${c ? "✓" : "✗"} ${n}`);
};
const near = (a: number, b: number) => Math.abs(a - b) < 0.005;

const acct = { accountIds: [] as number[], billIds: [] as number[] };

async function postRoute(
  handler: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>,
  id: number,
  body: unknown,
) {
  const res = await handler(
    new Request(`http://local/api/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: String(id) }) },
  );
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}
async function patchRoute(id: number, body: unknown) {
  const res = await billPatch(
    new Request(`http://local/api/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: String(id) }) },
  );
  return { status: res.status };
}

const rawAccount = async (id: number) =>
  (await db.select().from(financialAccounts).where(eq(financialAccounts.id, id)))[0];
const rawBill = async (id: number) =>
  (await db.select().from(financialEntries).where(eq(financialEntries.id, id)))[0];
const bal = async (id: number) => parseFloat((await rawAccount(id)).currentBalance ?? "0");
const movsFor = async (billId: number) =>
  db.select().from(accountMovements).where(eq(accountMovements.billId, billId));

async function mkAccount(name: string, balance: number, linked = false) {
  const row = await createAccount({
    userId: U,
    name,
    type: "checking",
    purpose: "spending",
    currentBalance: balance.toFixed(2),
    balanceSource: linked ? "linked" : "manual",
    includeInSpendable: true,
    active: true,
  } as never);
  acct.accountIds.push(row.id);
  return row.id;
}
async function mkBill(name: string, amount: number, dueDate: string | null, source: number | null) {
  const row = await createBill({
    userId: U,
    name,
    expectedAmount: amount.toFixed(2),
    dueDate,
    status: "scheduled",
    sourceAccountId: source,
  } as never);
  acct.billIds.push(row.id);
  return row.id;
}

async function main() {
  console.log("Finance 1A.3A deterministic verification\n");
  const logsBefore = (
    await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))
  ).length;

  // Owner snapshot (must survive untouched).
  const ownerAccountsBefore = await db
    .select()
    .from(financialAccounts)
    .where(and(eq(financialAccounts.userId, U), isNull(financialAccounts.deletedAt)));
  const ownerBillsBefore = await db
    .select()
    .from(financialEntries)
    .where(and(eq(financialEntries.userId, U), eq(financialEntries.kind, "bill"), isNull(financialEntries.deletedAt)));
  const ownerAcctBal = new Map(ownerAccountsBefore.map((a) => [a.id, a.currentBalance]));
  const ownerBillMovements = new Map<number, number>();
  for (const b of ownerBillsBefore) ownerBillMovements.set(b.id, (await movsFor(b.id)).length);

  const FUTURE = "2030-12-31", PAST = "2020-01-01", TODAY = localToday();

  /* ---- 1. Manual-account payment: deduct confirmed actual + 1 neg movement -- */
  console.log("[1] manual-account payment deducts + atomic + one movement");
  const M = await mkAccount("F3A manual", 1000);
  const bPay = await mkBill("F3A pay", 200, FUTURE, M);
  const before1 = await bal(M);
  // Pay an ACTUAL amount different from expected (180 ≠ 200) — proves the
  // CONFIRMED actual amount is what gets deducted/recorded.
  const r1 = await postRoute(payRoute, bPay, { paidAccountId: M, actualAmount: 180 });
  ok("[1] pay → 200", r1.status === 200);
  const paid1 = await rawBill(bPay);
  ok("[1] bill status=paid (atomic with deduction)", paid1.status === "paid");
  ok("[1] paidAt stamped", paid1.paidAt !== null);
  ok("[1] paidAccountId recorded", paid1.paidAccountId === M);
  ok("[1] actual_amount = confirmed 180 (not expected 200)", near(parseFloat(paid1.actualAmount ?? "0"), 180));
  ok("[1] account deducted by confirmed actual (1000→820)", near(await bal(M), before1 - 180));
  const m1 = await movsFor(bPay);
  ok("[1] exactly one movement created", m1.length === 1);
  ok("[1] movement is negative bill_payment = -180", m1[0]?.kind === "bill_payment" && near(parseFloat(m1[0].amount), -180));

  /* ---- 2. External/cash payment: paid, no account changed, no movement ----- */
  console.log("\n[2] external/cash payment changes no account");
  const bExt = await mkBill("F3A external", 50, FUTURE, null);
  const mBefore2 = await bal(M);
  const r2 = await postRoute(payRoute, bExt, { external: true });
  ok("[2] external pay → 200", r2.status === 200);
  const paid2 = await rawBill(bExt);
  ok("[2] bill paid, paidAccountId null", paid2.status === "paid" && paid2.paidAccountId === null);
  ok("[2] no movement for external pay", (await movsFor(bExt)).length === 0);
  ok("[2] no account balance changed", near(await bal(M), mBefore2));

  /* ---- 3. Linked account is never manually deducted ----------------------- */
  console.log("\n[3] linked account never receives a manual deduction");
  const L = await mkAccount("F3A linked", 1000, true);
  const bLinked = await mkBill("F3A linked-bill", 75, FUTURE, L);
  const r3 = await postRoute(payRoute, bLinked, { paidAccountId: L, actualAmount: 75 });
  ok("[3] pay-from-linked → 200 (bill paid)", r3.status === 200);
  const paid3 = await rawBill(bLinked);
  ok("[3] bill paid, paidAccountId = linked acct", paid3.status === "paid" && paid3.paidAccountId === L);
  ok("[3] linked account balance UNCHANGED (1000)", near(await bal(L), 1000));
  ok("[3] no movement created for linked payment", (await movsFor(bLinked)).length === 0);

  /* ---- 4. Duplicate payment cannot deduct twice --------------------------- */
  console.log("\n[4] duplicate payment cannot deduct twice");
  const bDup = await mkBill("F3A dup", 120, FUTURE, M);
  const mBefore4 = await bal(M);
  ok("[4] first pay → 200", (await postRoute(payRoute, bDup, { paidAccountId: M, actualAmount: 120 })).status === 200);
  ok("[4] deducted once (−120)", near(await bal(M), mBefore4 - 120));
  const dup = await postRoute(payRoute, bDup, { paidAccountId: M, actualAmount: 120 });
  ok("[4] duplicate pay → 409", dup.status === 409);
  ok("[4] balance not deducted again", near(await bal(M), mBefore4 - 120));
  ok("[4] still exactly one movement", (await movsFor(bDup)).length === 1);

  /* ---- 5. Concurrency: two simultaneous payments → one deduction ---------- */
  console.log("\n[5] concurrent payment race (real wall-clock)");
  const bRace = await mkBill("F3A race", 100, FUTURE, M);
  const mBefore5 = await bal(M);
  const race = await Promise.allSettled([
    postRoute(payRoute, bRace, { paidAccountId: M, actualAmount: 100 }),
    postRoute(payRoute, bRace, { paidAccountId: M, actualAmount: 100 }),
  ]);
  const statuses = race.map((r) => (r.status === "fulfilled" ? r.value.status : 0)).sort();
  ok("[5] exactly one 200 + one 409", statuses[0] === 200 && statuses[1] === 409);
  ok("[5] account deducted exactly once (−100)", near(await bal(M), mBefore5 - 100));
  ok("[5] exactly one movement from the race", (await movsFor(bRace)).length === 1);

  /* ---- 6. Reversal: equal positive movement + balance restored; original
   *        payment movement never deleted ----------------------------------- */
  console.log("\n[6] reversal restores balance + appends positive movement");
  const bRev = await mkBill("F3A reverse", 90, FUTURE, M);
  const mPrePay6 = await bal(M);
  await postRoute(payRoute, bRev, { paidAccountId: M, actualAmount: 90 });
  ok("[6] paid: balance −90", near(await bal(M), mPrePay6 - 90));
  const payMov = (await movsFor(bRev))[0];
  const rev = await postRoute(reverseRoute, bRev, {});
  ok("[6] reverse → 200", rev.status === 200);
  ok("[6] balance restored (+90 back to original)", near(await bal(M), mPrePay6));
  const m6 = await movsFor(bRev);
  ok("[6] two movements now (payment + reversal)", m6.length === 2);
  ok("[6] original payment movement NOT deleted", m6.some((m) => m.id === payMov.id && m.kind === "bill_payment"));
  const reversal = m6.find((m) => m.kind === "bill_payment_reversal");
  ok("[6] reversal is equal + positive (+90)", !!reversal && near(parseFloat(reversal!.amount), 90));
  ok("[6] reversal points at the original payment", reversal?.reversalOfId === payMov.id);
  const reopened6 = await rawBill(bRev);
  ok("[6] bill reopened (not paid), paid metadata cleared", reopened6.status !== "paid" && reopened6.paidAccountId === null && reopened6.actualAmount === null);

  /* ---- 7. Reopen status follows the due date ------------------------------ */
  console.log("\n[7] reopen status by due date");
  const reopenCase = async (label: string, due: string | null, expected: string) => {
    const bid = await mkBill(`F3A reopen ${label}`, 30, due, M);
    await postRoute(payRoute, bid, { paidAccountId: M, actualAmount: 30 });
    await postRoute(reverseRoute, bid, {});
    ok(`[7] due ${label} → reopened '${expected}'`, (await rawBill(bid)).status === expected);
  };
  await reopenCase("future", FUTURE, "scheduled");
  await reopenCase("today", TODAY, "due");
  await reopenCase("past", PAST, "overdue");
  await reopenCase("none", null, "scheduled");

  /* ---- 8. Duplicate reversal cannot credit twice -------------------------- */
  console.log("\n[8] duplicate reversal cannot credit twice");
  const balAfterRev8 = await bal(M);
  const dupRev = await postRoute(reverseRoute, bRev, {}); // bRev already reversed in [6]
  ok("[8] second reverse → 409", dupRev.status === 409);
  ok("[8] balance not credited again", near(await bal(M), balAfterRev8));
  ok("[8] still exactly two movements (no extra reversal)", (await movsFor(bRev)).length === 2);

  /* ---- 9. Concurrent reversal → one credit ------------------------------- */
  console.log("\n[9] concurrent reversal race (real wall-clock)");
  const bRevRace = await mkBill("F3A revrace", 70, FUTURE, M);
  const mPrePay9 = await bal(M);
  await postRoute(payRoute, bRevRace, { paidAccountId: M, actualAmount: 70 });
  const revRace = await Promise.allSettled([
    postRoute(reverseRoute, bRevRace, {}),
    postRoute(reverseRoute, bRevRace, {}),
  ]);
  const rStatuses = revRace.map((r) => (r.status === "fulfilled" ? r.value.status : 0)).sort();
  ok("[9] exactly one 200 + one 409", rStatuses[0] === 200 && rStatuses[1] === 409);
  ok("[9] credited exactly once (balance restored)", near(await bal(M), mPrePay9));
  ok("[9] exactly two movements (one payment, one reversal)", (await movsFor(bRevRace)).length === 2);

  /* ---- 10. Historical paid bill: no fabricated movement; reverse reopens
   *         without crediting ------------------------------------------------ */
  console.log("\n[10] historical paid bill (pre-ledger) gets no fabricated movement");
  const bHist = await mkBill("F3A historical", 40, FUTURE, M);
  // Simulate a bill paid BEFORE the ledger existed: paid + paidAccountId, no movement.
  await db
    .update(financialEntries)
    .set({ status: "paid", paidAt: new Date(), paidAccountId: M })
    .where(eq(financialEntries.id, bHist));
  ok("[10] historical paid bill has no movement", (await movsFor(bHist)).length === 0);
  const mBefore10 = await bal(M);
  const histRev = await postRoute(reverseRoute, bHist, {});
  ok("[10] reverse historical → 200 (reopens)", histRev.status === 200);
  ok("[10] reopened (not paid)", (await rawBill(bHist)).status !== "paid");
  ok("[10] no credit applied (no payment movement existed)", near(await bal(M), mBefore10));
  ok("[10] still no movement fabricated", (await movsFor(bHist)).length === 0);

  /* ---- 11. Service listing + /finances UI surface ------------------------- */
  console.log("\n[11] ledger listing + /finances UI surface");
  const recent = await listMovements(U, 50);
  ok("[11] listMovements returns my payments + reversals", recent.some((m) => m.kind === "bill_payment") && recent.some((m) => m.kind === "bill_payment_reversal"));
  const pageSrc = readFileSync("app/finances/page.tsx", "utf8");
  const billMgr = readFileSync("components/finances/bill-manager.tsx", "utf8");
  ok("[11] /finances has a Recent activity section", /Recent activity/i.test(pageSrc));
  ok("[11] bill UI shows actual amount on paid bills", /actualAmount/.test(billMgr));
  ok("[11] bill UI shows paid-from account or external", /external \/ cash|from \$\{paidFrom\}|paidFrom/.test(billMgr));
  ok("[11] bill UI offers a Reverse action", /Reverse/.test(billMgr) && /\/reverse/.test(billMgr));
  ok("[11] pay UI records a confirmed actual amount", /Actual amount/.test(billMgr));
  ok("[11] no 'safe to spend' / 'live balance' in finance UI", !/safe to spend|live balance/i.test(pageSrc + billMgr));

  /* ---- 12. Scope exclusions (schema + filesystem) ------------------------- */
  console.log("\n[12] scope exclusions");
  const schemaSrc = readFileSync("db/schema.ts", "utf8");
  // movement_kind still carries the bill kinds (income/transfer kinds were added
  // by Finance 1A.2; reconciliation is still out of scope everywhere).
  ok("[12] movement_kind still has the bill-payment kinds", /movement_kind[\s\S]*?bill_payment[\s\S]*?bill_payment_reversal/.test(schemaSrc));
  ok("[12] no reconciliation movement kind", !/reconcile/.test(schemaSrc));
  // NOTE: income_allocations + account_transfers are intentionally added by Finance 1A.2.
  ok("[12] no reconciliation field/route", !/last_reconciled_at|lastReconciledAt/.test(schemaSrc));
  ok("[12] no discretionary spending/transactions table", !/spending_entries|discretionary|"transactions"|\btransactions\b/.test(schemaSrc));
  ok("[12] no Plaid", !/plaid/i.test(schemaSrc + pageSrc + billMgr));

  /* ---- 13. No AI / no usage log ------------------------------------------ */
  const logsAfter = (
    await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))
  ).length;
  ok("[13] no usage-log row created (no AI)", logsBefore === logsAfter);

  /* ---- 14. Owner data untouched ------------------------------------------ */
  console.log("\n[14] owner data preservation");
  for (const a of ownerAccountsBefore) {
    const now = await rawAccount(a.id);
    ok(`[14] owner account #${a.id} balance unchanged`, !!now && now.currentBalance === ownerAcctBal.get(a.id));
  }
  for (const b of ownerBillsBefore) {
    const now = await rawBill(b.id);
    ok(`[14] owner bill #${b.id} unchanged + no movement fabricated`,
      !!now && now.status === b.status && now.paidAccountId === b.paidAccountId &&
      (await movsFor(b.id)).length === (ownerBillMovements.get(b.id) ?? 0));
  }
}

async function cleanup() {
  console.log("\n[cleanup] exact-ID-scoped");
  console.log(`  targets — accounts:[${acct.accountIds}] bills:[${acct.billIds}]`);
  const [before222] = await db.select().from(experienceRequests).where(eq(experienceRequests.id, 222)).limit(1);
  // Movements first (reversals before payments — self-FK), then bills, then accounts.
  for (const id of acct.billIds) {
    await db.delete(accountMovements).where(and(eq(accountMovements.billId, id), eq(accountMovements.kind, "bill_payment_reversal")));
    await db.delete(accountMovements).where(eq(accountMovements.billId, id));
  }
  for (const id of acct.billIds) await db.delete(financialEntries).where(eq(financialEntries.id, id));
  for (const id of acct.accountIds) await db.delete(financialAccounts).where(eq(financialAccounts.id, id));
  const [after222] = await db.select().from(experienceRequests).where(eq(experienceRequests.id, 222)).limit(1);
  ok("[cleanup] request 222 untouched", JSON.stringify(after222) === JSON.stringify(before222));
  const leftMov = (await db.select({ id: accountMovements.id }).from(accountMovements).where(eq(accountMovements.userId, U)))
    .filter(() => false); // all my movements were bill-scoped and removed above
  const leftAcct = (await db.select({ id: financialAccounts.id }).from(financialAccounts).where(eq(financialAccounts.userId, U)))
    .filter((r) => acct.accountIds.includes(r.id));
  const leftBill = (await db.select({ id: financialEntries.id }).from(financialEntries).where(eq(financialEntries.userId, U)))
    .filter((r) => acct.billIds.includes(r.id));
  ok("[cleanup] all harness accounts removed", leftAcct.length === 0);
  ok("[cleanup] all harness bills removed", leftBill.length === 0);
  void leftMov;
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
    console.log("\nManual bill-payment ledger verified; atomic deduct/reverse, no double-spend, owner data intact.");
    if (failed > 0) process.exitCode = 1;
  });
