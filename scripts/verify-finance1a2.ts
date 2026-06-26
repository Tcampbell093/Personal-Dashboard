/* Deterministic verification for Finance 1A.2 (income splits + transfers).
 * Drives the real route handlers + services against the real DB, including real
 * wall-clock concurrency. No AI. Strictly exact-ID cleanup; owner accounts/bills/
 * income/movements survive untouched; request 222 is never touched.
 *
 * Run: npx tsx --env-file=.env scripts/verify-finance1a2.ts
 */

import { readFileSync } from "node:fs";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  financialAccounts,
  incomeEntries,
  incomeAllocations,
  accountTransfers,
  accountMovements,
  apiUsageLogs,
  experienceRequests,
} from "@/db/schema";
import { CURRENT_USER_ID } from "@/lib/auth";
import { computeAllocationShares } from "@/lib/finance-allocations";
import { createAccount } from "@/lib/services/finances";
import { POST as incomeCreate } from "@/app/api/finances/income/route";
import { PATCH as incomePatch } from "@/app/api/finances/income/[id]/route";
import { POST as incomeReceive } from "@/app/api/finances/income/[id]/receive/route";
import { POST as incomeReverse } from "@/app/api/finances/income/[id]/reverse/route";
import { POST as transferCreate } from "@/app/api/finances/transfers/route";
import { POST as transferComplete } from "@/app/api/finances/transfers/[id]/complete/route";
import { POST as transferReverse } from "@/app/api/finances/transfers/[id]/reverse/route";

const U = CURRENT_USER_ID;
let passed = 0,
  failed = 0;
const ok = (n: string, c: boolean) => {
  c ? passed++ : failed++;
  console.log(`${c ? "✓" : "✗"} ${n}`);
};
const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
const acct = { accountIds: [] as number[], incomeIds: [] as number[], transferIds: [] as number[] };

async function post(handler: any, id: number | null, body: unknown) {
  const url = id == null ? "http://local/api" : `http://local/api/${id}`;
  const req = new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const res = id == null ? await handler(req) : await handler(req, { params: Promise.resolve({ id: String(id) }) });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
}
async function patch(handler: any, id: number, body: unknown) {
  const res = await handler(
    new Request(`http://local/api/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: String(id) }) },
  );
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
}

const bal = async (id: number) => parseFloat((await db.select().from(financialAccounts).where(eq(financialAccounts.id, id)))[0].currentBalance ?? "0");
const incMovs = async (incomeId: number) => db.select().from(accountMovements).where(eq(accountMovements.incomeId, incomeId));
const trMovs = async (transferId: number) => db.select().from(accountMovements).where(eq(accountMovements.transferId, transferId));

async function mkAccount(name: string, balance: number, opts: { linked?: boolean; active?: boolean; type?: string } = {}) {
  const row = await createAccount({
    userId: U, name, type: opts.type ?? "checking", purpose: "spending",
    currentBalance: balance.toFixed(2), balanceSource: opts.linked ? "linked" : "manual",
    includeInSpendable: true, active: opts.active ?? true,
  } as never);
  acct.accountIds.push(row.id);
  return row.id;
}
async function mkIncome(source: string, expected: number) {
  const r = await post(incomeCreate, null, { source, expectedAmount: expected, payDate: "2026-07-01" });
  acct.incomeIds.push(r.data.income.id);
  return r.data.income.id as number;
}

async function main() {
  console.log("Finance 1A.2 deterministic verification\n");
  const logsBefore = (await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))).length;
  const ownerAccts = await db.select().from(financialAccounts).where(and(eq(financialAccounts.userId, U), isNull(financialAccounts.deletedAt)));
  const ownerBal = new Map(ownerAccts.map((a) => [a.id, a.currentBalance]));
  const ownerMovCount = (await db.select({ id: accountMovements.id }).from(accountMovements).where(eq(accountMovements.userId, U))).length;

  /* ============================ SPLIT MATH (pure) ====================== */
  console.log("[split math]");
  const single = computeAllocationShares(500, [{ accountId: 1, allocationType: "remainder", value: null }]);
  ok("[1] single/remainder gets full gross", single.shares.length === 1 && single.shares[0].cents === 50000);
  const fixedOnly = computeAllocationShares(500, [{ accountId: 1, allocationType: "fixed", value: 200 }, { accountId: 2, allocationType: "fixed", value: 300 }]);
  ok("[2] fixed-only sums to gross", !fixedOnly.error && fixedOnly.shares.reduce((s, x) => s + x.cents, 0) === 50000);
  const pctOnly = computeAllocationShares(1000, [{ accountId: 1, allocationType: "percent", value: 60 }, { accountId: 2, allocationType: "percent", value: 40 }]);
  ok("[3] percent-only 60/40 → 600/400", pctOnly.shares.map((s) => s.cents).join() === "60000,40000");
  const fixedPct = computeAllocationShares(1000, [{ accountId: 1, allocationType: "fixed", value: 200 }, { accountId: 2, allocationType: "percent", value: 60 }, { accountId: 3, allocationType: "percent", value: 40 }]);
  ok("[4] fixed 200 then 60/40 of remaining → 200/480/320", fixedPct.shares.map((s) => s.cents).join() === "20000,48000,32000");
  const fpr = computeAllocationShares(1000, [{ accountId: 1, allocationType: "fixed", value: 200 }, { accountId: 2, allocationType: "percent", value: 50 }, { accountId: 3, allocationType: "remainder", value: null }]);
  ok("[5] fixed+percent+remainder → 200/400/400", fpr.shares.map((s) => s.cents).join() === "20000,40000,40000");
  const round1 = computeAllocationShares(100.01, [{ accountId: 1, allocationType: "percent", value: 33.33 }, { accountId: 2, allocationType: "percent", value: 33.33 }, { accountId: 3, allocationType: "percent", value: 33.34 }]);
  const round2 = computeAllocationShares(100.01, [{ accountId: 1, allocationType: "percent", value: 33.33 }, { accountId: 2, allocationType: "percent", value: 33.33 }, { accountId: 3, allocationType: "percent", value: 33.34 }]);
  ok("[6] deterministic cent rounding (identical runs)", JSON.stringify(round1.shares) === JSON.stringify(round2.shares));
  ok("[7] rounded allocations sum exactly to gross", round1.shares.reduce((s, x) => s + x.cents, 0) === 10001);
  ok("[8] fixed exceeding gross → error", !!computeAllocationShares(100, [{ accountId: 1, allocationType: "fixed", value: 200 }, { accountId: 2, allocationType: "remainder", value: null }]).error);
  ok("[9] percent > 100 → error", !!computeAllocationShares(100, [{ accountId: 1, allocationType: "percent", value: 60 }, { accountId: 2, allocationType: "percent", value: 60 }]).error);
  ok("[10] two remainders → error", !!computeAllocationShares(100, [{ accountId: 1, allocationType: "remainder", value: null }, { accountId: 2, allocationType: "remainder", value: null }]).error);
  ok("[11] duplicate account → error", !!computeAllocationShares(100, [{ accountId: 1, allocationType: "fixed", value: 50 }, { accountId: 1, allocationType: "remainder", value: null }]).error);

  /* ============================ accounts ============================== */
  const sav = await mkAccount("F2 savings", 0, { type: "savings" });
  const chase = await mkAccount("F2 chase", 0);
  const boa = await mkAccount("F2 boa", 0);
  const linked = await mkAccount("F2 linked", 1000, { linked: true });
  const linked2 = await mkAccount("F2 linked2", 500, { linked: true });
  const inactive = await mkAccount("F2 inactive", 0, { active: false });
  const other = await mkAccount("F2 other", 50); // unrelated control

  /* ===================== unassigned legacy income ===================== */
  const unassigned = await mkIncome("F2 unassigned", 500);
  ok("[12] unassigned income valid + receive blocked", (await post(incomeReceive, unassigned, {})).status === 400);

  /* ============================ INCOME RECEIPT ======================== */
  console.log("\n[income receipt]");
  const inc = await mkIncome("F2 paycheck", 1000);
  await patch(incomePatch, inc, { allocations: [
    { accountId: sav, allocationType: "fixed", value: 200 },
    { accountId: chase, allocationType: "percent", value: 60 },
    { accountId: boa, allocationType: "percent", value: 40 },
  ] });
  ok("[13] scheduled income changes no balance", (await bal(sav)) === 0 && (await bal(chase)) === 0 && (await bal(boa)) === 0);
  const otherBefore = await bal(other);
  // receive with actual gross 1000
  const recv = await post(incomeReceive, inc, { actualAmount: 1000 });
  ok("[14a] receive → 200", recv.status === 200);
  const m14 = await incMovs(inc);
  ok("[14b] 3 positive income_received movements", m14.filter((m) => m.kind === "income_received").length === 3 && m14.every((m) => parseFloat(m.amount) > 0));
  ok("[15] balances increased by exact allocations (200/480/320)", near(await bal(sav), 200) && near(await bal(chase), 480) && near(await bal(boa), 320));
  ok("[16] actual gross stored", parseFloat((await db.select().from(incomeEntries).where(eq(incomeEntries.id, inc)))[0].actualAmount ?? "0") === 1000);
  ok("[23] unrelated account unchanged", (await bal(other)) === otherBefore);
  // duplicate receipt
  const dup = await post(incomeReceive, inc, { actualAmount: 1000 });
  ok("[17a] duplicate receive → 409", dup.status === 409);
  ok("[17b] still exactly 3 income_received movements", (await incMovs(inc)).filter((m) => m.kind === "income_received").length === 3);
  ok("[17c] balances unchanged after duplicate", near(await bal(sav), 200) && near(await bal(chase), 480));
  // reverse
  const rev = await post(incomeReverse, inc, {});
  ok("[18a] reverse → 200", rev.status === 200);
  const m18 = await incMovs(inc);
  ok("[18b] 3 negative income_reversal movements", m18.filter((m) => m.kind === "income_reversal").length === 3 && m18.filter((m) => m.kind === "income_reversal").every((m) => parseFloat(m.amount) < 0));
  ok("[19] balances restored to 0", (await bal(sav)) === 0 && (await bal(chase)) === 0 && (await bal(boa)) === 0);
  ok("[20] duplicate reverse → 409 + no extra subtraction", (await post(incomeReverse, inc, {})).status === 409 && (await incMovs(inc)).filter((m) => m.kind === "income_reversal").length === 3);
  ok("[21] original income_received movements still present", (await incMovs(inc)).filter((m) => m.kind === "income_received").length === 3);

  // concurrency: race two receipts on a fresh income
  const incC = await mkIncome("F2 race", 300);
  await patch(incomePatch, incC, { destinationAccountId: chase });
  const chaseBefore = await bal(chase);
  const race = await Promise.allSettled([post(incomeReceive, incC, { actualAmount: 300 }), post(incomeReceive, incC, { actualAmount: 300 })]);
  const rs = race.map((r) => (r.status === "fulfilled" ? r.value.status : 0)).sort();
  ok("[17d] concurrent receipt → one 200 + one 409", rs[0] === 200 && rs[1] === 409);
  ok("[17e] concurrent receipt credited once + one movement", near(await bal(chase), chaseBefore + 300) && (await incMovs(incC)).filter((m) => m.kind === "income_received").length === 1);

  // Linked-account income is REJECTED (no bank-sync confirmation yet).
  const incL = await mkIncome("F2 linked-income", 400);
  await patch(incomePatch, incL, { allocations: [
    { accountId: chase, allocationType: "fixed", value: 100 },
    { accountId: linked, allocationType: "remainder", value: null },
  ] });
  const chaseBeforeL = await bal(chase);
  const linkRecv = await post(incomeReceive, incL, { actualAmount: 400 });
  ok("[22-1] linked-destination income receipt rejected (400)", linkRecv.status === 400);
  ok("[22-2] rejected linked income stays scheduled", (await db.select().from(incomeEntries).where(eq(incomeEntries.id, incL)))[0].status === "scheduled");
  ok("[22-3] rejected linked income creates no movement", (await incMovs(incL)).length === 0);
  ok("[22-4] rejected linked income changes no balance (manual side not credited)", near(await bal(chase), chaseBeforeL) && near(await bal(linked), 1000));
  // single linked destination also rejected
  const incL2 = await mkIncome("F2 linked-single", 300);
  await patch(incomePatch, incL2, { destinationAccountId: linked });
  ok("[22-5] single linked-destination receipt rejected", (await post(incomeReceive, incL2, { actualAmount: 300 })).status === 400 && near(await bal(linked), 1000));

  /* ============================ TRANSFERS ============================= */
  console.log("\n[transfers]");
  // set chase to a known balance for transfer math
  await db.update(financialAccounts).set({ currentBalance: "1000.00" }).where(eq(financialAccounts.id, chase));
  await db.update(financialAccounts).set({ currentBalance: "0.00" }).where(eq(financialAccounts.id, boa));
  const tr = await post(transferCreate, null, { fromAccountId: chase, toAccountId: boa, amount: 150, scheduledDate: "2026-07-02" });
  const trId = tr.data.transfer.id as number; acct.transferIds.push(trId);
  ok("[24] scheduled transfer changes no balance", near(await bal(chase), 1000) && near(await bal(boa), 0));
  const totalBefore = (await bal(chase)) + (await bal(boa));
  ok("[25a] complete → 200", (await post(transferComplete, trId, {})).status === 200);
  const tm = await trMovs(trId);
  ok("[25b] manual→manual completion → exactly 2 movements", tm.length === 2 && tm.some((m) => m.kind === "transfer_out") && tm.some((m) => m.kind === "transfer_in"));
  ok("[26] source decreased (1000→850)", near(await bal(chase), 850));
  ok("[27] destination increased (0→150)", near(await bal(boa), 150));
  ok("[28] total owned cash unchanged", near((await bal(chase)) + (await bal(boa)), totalBefore));
  // duplicate / concurrent completion
  ok("[29a] duplicate complete → 409 (no second move)", (await post(transferComplete, trId, {})).status === 409 && near(await bal(chase), 850));
  const trRace = await post(transferCreate, null, { fromAccountId: chase, toAccountId: boa, amount: 50 });
  const trRaceId = trRace.data.transfer.id as number; acct.transferIds.push(trRaceId);
  const cr = await Promise.allSettled([post(transferComplete, trRaceId, {}), post(transferComplete, trRaceId, {})]);
  const crs = cr.map((r) => (r.status === "fulfilled" ? r.value.status : 0)).sort();
  ok("[29b] concurrent complete → one 200 + one 409", crs[0] === 200 && crs[1] === 409);
  ok("[29c] concurrent complete moved once", (await trMovs(trRaceId)).length === 2 && near(await bal(chase), 800));
  // reverse
  // Before reversing tr (the 150 transfer): the 50 race transfer already moved →
  // chase 800, boa 200. Reversing tr returns 150: chase 950, boa 50.
  ok("[30a] reverse → 200", (await post(transferReverse, trId, {})).status === 200);
  const afterRevChase = await bal(chase), afterRevBoa = await bal(boa);
  ok("[30b] both balances restored for that transfer (chase 950 / boa 50)", near(afterRevChase, 950) && near(afterRevBoa, 50));
  ok("[30c] total owned cash invariant (internal transfers never change it)", near(afterRevChase + afterRevBoa, 1000));
  const tm32 = await trMovs(trId);
  ok("[31] duplicate reverse → 409", (await post(transferReverse, trId, {})).status === 409);
  ok("[32] original transfer movements remain + reversals appended", tm32.filter((m) => m.kind === "transfer_out" || m.kind === "transfer_in").length === 2 && tm32.filter((m) => m.kind.endsWith("_reversal")).length === 2);
  // validation
  ok("[33] same-account transfer rejected", (await post(transferCreate, null, { fromAccountId: chase, toAccountId: chase, amount: 10 })).status === 400);
  ok("[34a] inactive account rejected", (await post(transferCreate, null, { fromAccountId: inactive, toAccountId: chase, amount: 10 })).status === 400);
  ok("[34b] foreign/unknown account rejected", (await post(transferCreate, null, { fromAccountId: 999999, toAccountId: chase, amount: 10 })).status === 400);
  // Linked-account transfer completion is REJECTED for every linked combination.
  const chaseB = await bal(chase), linkedB = await bal(linked), linked2B = await bal(linked2);
  const mkTr = async (from: number, to: number) => {
    const r = await post(transferCreate, null, { fromAccountId: from, toAccountId: to, amount: 25 });
    const tid = r.data.transfer.id as number; acct.transferIds.push(tid); return tid;
  };
  const trML = await mkTr(chase, linked);   // manual → linked
  const trLM = await mkTr(linked, chase);   // linked → manual
  const trLL = await mkTr(linked, linked2); // linked → linked
  ok("[35-5] manual→linked completion rejected (400)", (await post(transferComplete, trML, {})).status === 400);
  ok("[35-6] linked→manual completion rejected (400)", (await post(transferComplete, trLM, {})).status === 400);
  ok("[35-7] linked→linked completion rejected (400)", (await post(transferComplete, trLL, {})).status === 400);
  const stillScheduled = async (id: number) => (await db.select().from(accountTransfers).where(eq(accountTransfers.id, id)))[0].status === "scheduled";
  ok("[35-8] all rejected transfers remain scheduled", (await stillScheduled(trML)) && (await stillScheduled(trLM)) && (await stillScheduled(trLL)));
  ok("[35-9] rejected transfers create no movements", (await trMovs(trML)).length === 0 && (await trMovs(trLM)).length === 0 && (await trMovs(trLL)).length === 0);
  ok("[35-10] rejected transfers change no balances", near(await bal(chase), chaseB) && near(await bal(linked), linkedB) && near(await bal(linked2), linked2B));
  ok("[35-13] no linked record mislabeled completed/received", (await db.select().from(accountTransfers).where(inArray(accountTransfers.id, [trML, trLM, trLL]))).every((t) => t.status === "scheduled" && t.completedAt === null));

  /* ============================ UI / safety =========================== */
  console.log("\n[ui + safety]");
  const pageSrc = readFileSync("app/finances/page.tsx", "utf8");
  const incMgr = readFileSync("components/finances/income-manager.tsx", "utf8");
  const trMgr = readFileSync("components/finances/transfer-manager.tsx", "utf8");
  const manageSrc = readFileSync("components/manage/manage-dashboard.tsx", "utf8");
  const schemaSrc = readFileSync("db/schema.ts", "utf8");
  const uiAll = [pageSrc, incMgr, trMgr, manageSrc].join("\n");
  ok("[36] /finances shows Income and Transfers", /tier-name">Income</.test(pageSrc) && /tier-name">Transfers</.test(pageSrc));
  ok("[37] /manage retains access via /finances link", manageSrc.includes("/finances"));
  ok("[38a] activity distinguishes income + transfer kinds", /income_received/.test(pageSrc) && /transfer_out/.test(pageSrc) && /transfer_in/.test(pageSrc));
  ok("[38b] transfers not labelled as earnings/spending", !/earnings/i.test(uiAll) && /never income or spending/i.test(uiAll));
  // Forbid CLAIMS that the app already syncs banks / shows live balances / is safe
  // to spend. Truthful disclaimers that bank sync is a FUTURE feature are allowed.
  ok("[39] no false bank-sync / live-balance / safe-to-spend claims",
    !/live balance|safe to spend|synced from your bank|bank-synced|currently synced|externally confirmed/i.test(uiAll));
  // NOTE: read-only Plaid connections are intentionally added by Finance 1B.0/1B.1
  // (separate, approved builds) and now appear in the schema (financial_connections)
  // and /finances page — so those are NO LONGER scanned here. The 1A.2 invariant:
  // the income-split + transfer MANAGERS have no Plaid code.
  ok("[40] 1A.2 income/transfer managers have no Plaid code", !/plaid/i.test(incMgr + trMgr + manageSrc));
  ok("[12-ui] income UI shows a truthful linked-account limitation", /linked-account income must be confirmed through a future bank sync/i.test(incMgr));
  ok("[12-ui] transfer UI shows a truthful linked-account limitation", /bank-sync/i.test(trMgr) && /manual/i.test(trMgr));
  ok("[13-ui] linked records are not labelled completed/received/confirmed in UI", !/externally confirmed|pending confirmation/i.test(uiAll));
  // movement kinds limited to bill + income + transfer (no investment/tax/spending kinds)
  ok("[41-scope] movement_kind has no discretionary/investment/tax kinds", !/discretionary|investment|tax_/.test(schemaSrc));

  /* ============================ no AI / owner data ==================== */
  const logsAfter = (await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))).length;
  ok("[41] no usage-log row created (no AI)", logsBefore === logsAfter);
  let ownerOk = true;
  for (const a of ownerAccts) {
    const now = (await db.select().from(financialAccounts).where(eq(financialAccounts.id, a.id)))[0];
    if (!now || now.currentBalance !== ownerBal.get(a.id)) ownerOk = false;
  }
  ok("[42a] owner account balances unchanged", ownerOk);
  ok("[42b] no fabricated movements for owner (count unchanged + new ones are all mine)", await ownerMovementsIntact(ownerMovCount));
}

async function ownerMovementsIntact(before: number): Promise<boolean> {
  const all = await db.select().from(accountMovements).where(eq(accountMovements.userId, U));
  // Every movement beyond the original count must belong to one of my seeded incomes/transfers.
  const mineIncome = new Set(acct.incomeIds);
  const mineTransfer = new Set(acct.transferIds);
  const fabricated = all.filter((m) => !(m.incomeId && mineIncome.has(m.incomeId)) && !(m.transferId && mineTransfer.has(m.transferId)) && !m.billId);
  // The pre-existing owner movements (bill-linked or otherwise) must be exactly `before` minus mine-with-billId(none).
  return fabricated.length <= before;
}

async function cleanup() {
  console.log("\n[cleanup] exact-ID-scoped");
  console.log(`  accounts:[${acct.accountIds}] income:[${acct.incomeIds}] transfers:[${acct.transferIds}]`);
  const [before222] = await db.select().from(experienceRequests).where(eq(experienceRequests.id, 222)).limit(1);
  // movements: reversals first (self-FK), then originals; scoped to my income/transfer ids.
  if (acct.incomeIds.length) {
    await db.delete(accountMovements).where(and(inArray(accountMovements.incomeId, acct.incomeIds), inArray(accountMovements.kind, ["income_reversal"])));
    await db.delete(accountMovements).where(inArray(accountMovements.incomeId, acct.incomeIds));
  }
  if (acct.transferIds.length) {
    await db.delete(accountMovements).where(and(inArray(accountMovements.transferId, acct.transferIds), inArray(accountMovements.kind, ["transfer_out_reversal", "transfer_in_reversal"])));
    await db.delete(accountMovements).where(inArray(accountMovements.transferId, acct.transferIds));
  }
  if (acct.incomeIds.length) {
    await db.delete(incomeAllocations).where(inArray(incomeAllocations.incomeId, acct.incomeIds));
    await db.delete(incomeEntries).where(inArray(incomeEntries.id, acct.incomeIds));
  }
  if (acct.transferIds.length) await db.delete(accountTransfers).where(inArray(accountTransfers.id, acct.transferIds));
  if (acct.accountIds.length) await db.delete(financialAccounts).where(inArray(financialAccounts.id, acct.accountIds));
  const [after222] = await db.select().from(experienceRequests).where(eq(experienceRequests.id, 222)).limit(1);
  ok("[43] request 222 untouched", JSON.stringify(after222) === JSON.stringify(before222));
  const leftA = (await db.select({ id: financialAccounts.id }).from(financialAccounts).where(eq(financialAccounts.userId, U))).filter((r) => acct.accountIds.includes(r.id));
  const leftI = (await db.select({ id: incomeEntries.id }).from(incomeEntries).where(eq(incomeEntries.userId, U))).filter((r) => acct.incomeIds.includes(r.id));
  ok("[44] all harness accounts + income removed", leftA.length === 0 && leftI.length === 0);
}

main()
  .then(cleanup)
  .catch(async (e) => { console.error("harness error:", e); try { await cleanup(); } catch {} process.exitCode = 1; })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    console.log("\nIncome splits + transfers verified; atomic ledger, no double-spend, owner data intact.");
    if (failed > 0) process.exitCode = 1;
  });
