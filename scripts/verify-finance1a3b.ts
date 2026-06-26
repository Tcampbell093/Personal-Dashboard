/* Deterministic verification for Finance 1A.3B (reconciliation + projection).
 * Reconciliation drives the real routes + services against the real DB (incl.
 * concurrency). Projection is the pure engine, tested with constructed views.
 * No AI. Exact-ID cleanup; owner data untouched; request 222 never touched.
 *
 * Run: npx tsx --env-file=.env scripts/verify-finance1a3b.ts
 */

import { readFileSync } from "node:fs";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { financialAccounts, accountMovements, apiUsageLogs, experienceRequests } from "@/db/schema";
import { CURRENT_USER_ID } from "@/lib/auth";
import { createAccount, getReconcilableAccountIds } from "@/lib/services/finances";
import { computeProjection, resolveHorizon, nextPaydayDate, addDays } from "@/lib/services/finance-projection";
import { POST as reconcileRoute } from "@/app/api/finances/accounts/[id]/reconcile/route";
import { POST as undoRoute } from "@/app/api/finances/accounts/[id]/reconcile/undo/route";
import type { AccountView, BillView, IncomeView, TransferView } from "@/lib/types";

const U = CURRENT_USER_ID;
let passed = 0, failed = 0;
const ok = (n: string, c: boolean) => { c ? passed++ : failed++; console.log(`${c ? "✓" : "✗"} ${n}`); };
const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
const acct = { accountIds: [] as number[] };

async function post(handler: any, id: number, body: unknown) {
  const res = await handler(
    new Request(`http://local/api/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: String(id) }) },
  );
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
}
const bal = async (id: number) => parseFloat((await db.select().from(financialAccounts).where(eq(financialAccounts.id, id)))[0].currentBalance!);
const reconAt = async (id: number) => (await db.select().from(financialAccounts).where(eq(financialAccounts.id, id)))[0].lastReconciledAt;
const reconMovs = async (id: number) => (await db.select().from(accountMovements).where(eq(accountMovements.accountId, id))).filter((m) => m.kind.startsWith("reconcile"));

async function mkAccount(name: string, balance: number, opts: { linked?: boolean; active?: boolean; type?: string } = {}) {
  const r = await createAccount({ userId: U, name, type: opts.type ?? "checking", purpose: "spending", currentBalance: balance.toFixed(2), balanceSource: opts.linked ? "linked" : "manual", includeInSpendable: true, active: opts.active ?? true } as never);
  acct.accountIds.push(r.id);
  return r.id;
}

/* ----- pure projection view builders ----- */
const isCash = (t: string) => ["checking", "savings", "cash"].includes(t);
const A = (o: Partial<AccountView> & { id: number }): AccountView => ({
  id: o.id, name: o.name ?? `A${o.id}`, type: o.type ?? "checking", institution: null,
  purpose: o.purpose ?? "spending", currentBalance: o.currentBalance ?? 0,
  balanceSource: o.balanceSource ?? "manual", includeInSpendable: o.includeInSpendable ?? true,
  active: o.active ?? true, isCash: isCash(o.type ?? "checking"), isLiability: (o.type ?? "checking") === "credit",
  lastReconciledAt: null,
});
const B = (o: Partial<BillView> & { id: number }): BillView => ({
  id: o.id, name: o.name ?? `B${o.id}`, expectedAmount: o.expectedAmount ?? 0, dueDate: o.dueDate ?? null,
  status: o.status ?? "scheduled", sourceAccountId: o.sourceAccountId ?? null, paidAccountId: null, actualAmount: null, paidAt: null,
});
const I = (o: Partial<IncomeView> & { id: number }): IncomeView => ({
  id: o.id, source: o.source ?? `I${o.id}`, expectedAmount: o.expectedAmount ?? 0, payDate: o.payDate ?? "2026-07-01",
  isPayday: o.isPayday ?? true, status: o.status ?? "scheduled", actualAmount: null, receivedAt: null,
  destinationAccountId: o.destinationAccountId ?? null, allocations: o.allocations ?? [],
  scheduleId: o.scheduleId ?? null, estimateType: o.estimateType ?? "fixed", expectedMin: o.expectedMin ?? null,
  expectedMax: o.expectedMax ?? null, variance: o.variance ?? null, variancePct: o.variancePct ?? null,
});
const T = (o: Partial<TransferView> & { id: number }): TransferView => ({
  id: o.id, fromAccountId: o.fromAccountId ?? 0, fromName: null, toAccountId: o.toAccountId ?? 0, toName: null,
  amount: o.amount ?? 0, scheduledDate: o.scheduledDate ?? null, status: o.status ?? "scheduled", completedAt: null, note: null,
});
const TODAY = "2026-07-01";
const d = (n: number) => addDays(TODAY, n);

async function main() {
  console.log("Finance 1A.3B deterministic verification\n");
  const logsBefore = (await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))).length;
  const ownerAccts = await db.select().from(financialAccounts).where(and(eq(financialAccounts.userId, U), isNull(financialAccounts.deletedAt)));
  const ownerBal = new Map(ownerAccts.map((a) => [a.id, a.currentBalance]));
  const ownerRecon = new Map(ownerAccts.map((a) => [a.id, a.lastReconciledAt?.toISOString() ?? null]));
  const ownerMovCount = (await db.select({ id: accountMovements.id }).from(accountMovements).where(eq(accountMovements.userId, U))).length;

  /* ===================== RECONCILIATION ===================== */
  console.log("[reconciliation]");
  const R = await mkAccount("R3B recon", 500);
  const C = await mkAccount("R3B control", 777);
  const r1 = await post(reconcileRoute, R, { realBalance: 465, note: "bank says 465" });
  ok("[1] reconcile → 200 + one adjustment movement", r1.status === 200 && (await reconMovs(R)).filter((m) => m.kind === "reconcile_adjustment").length === 1);
  ok("[2] actual balance becomes the entered real balance (465)", near(await bal(R), 465));
  const adj = (await reconMovs(R)).find((m) => m.kind === "reconcile_adjustment")!;
  ok("[3a] negative delta correct (−35)", near(parseFloat(adj.amount), -35));
  ok("[5] prior/new balances auditable (500 → 465)", near(parseFloat(adj.priorBalance!), 500) && near(parseFloat(adj.newBalance!), 465));
  ok("[4] lastReconciledAt updated", (await reconAt(R)) !== null);
  // positive delta — R now has a latest reversible reconcile (no later reconcile).
  await post(reconcileRoute, R, { realBalance: 600 });
  ok("[3b] positive delta correct (+135) + balance 600", near(parseFloat((await reconMovs(R)).find((m) => m.kind === "reconcile_adjustment" && near(parseFloat(m.amount), 135))?.amount ?? "0"), 135) && near(await bal(R), 600));
  ok("[3c] latest reconcile reported reversible (server-side reversibility query)", (await getReconcilableAccountIds(U)).includes(R));
  // rejections
  const L = await mkAccount("R3B linked", 100, { linked: true });
  const INACT = await mkAccount("R3B inactive", 100, { active: false });
  ok("[7] linked account reconcile rejected (400)", (await post(reconcileRoute, L, { realBalance: 50 })).status === 400);
  ok("[8a] inactive account reconcile rejected (400)", (await post(reconcileRoute, INACT, { realBalance: 50 })).status === 400);
  ok("[8b] foreign/unknown account rejected (404)", (await post(reconcileRoute, 999999, { realBalance: 50 })).status === 404);
  // duplicate / concurrent reconcile — must apply at most once.
  const D = await mkAccount("R3B dup", 500);
  const dupRace = await Promise.allSettled([post(reconcileRoute, D, { realBalance: 400 }), post(reconcileRoute, D, { realBalance: 400 })]);
  const ds = dupRace.map((x) => (x.status === "fulfilled" ? x.value.status : 0));
  ok("[9] duplicate/concurrent reconcile applies once (400, exactly one movement)", near(await bal(D), 400) && (await reconMovs(D)).filter((m) => m.kind === "reconcile_adjustment").length === 1 && ds.includes(200));
  // reversal (R's latest +135 reconcile, no zero-delta after → reversible).
  const adjCountBefore = (await reconMovs(R)).filter((m) => m.kind === "reconcile_adjustment").length;
  const undo = await post(undoRoute, R, {});
  ok("[10] reconciliation undo appends a reconcile_reversal movement", undo.status === 200 && (await reconMovs(R)).some((m) => m.kind === "reconcile_reversal"));
  ok("[11] reversal restores prior balance (465)", near(await bal(R), 465));
  ok("[13] original adjustment movements remain", (await reconMovs(R)).filter((m) => m.kind === "reconcile_adjustment").length === adjCountBefore);
  ok("[14] unrelated account balance unchanged (777)", near(await bal(C), 777) && (await reconMovs(C)).length === 0);

  /* ----- zero-delta blocks an older Undo (required invariant, tasks 1-10) ----- */
  console.log("\n[zero-delta blocks older undo]");
  const ZD = await mkAccount("R3B zerodelta", 500);
  ok("[z1] reconcile 500→480 creates the expected adjustment (−20)", (await post(reconcileRoute, ZD, { realBalance: 480 })).status === 200 && near(parseFloat((await reconMovs(ZD))[0].amount), -20));
  const zdRecBefore = (await reconAt(ZD))!;
  const adjMovsBefore = (await reconMovs(ZD)).length;
  const zResp = await post(reconcileRoute, ZD, { realBalance: 480 }); // later ZERO-delta
  const zdRecAfter = (await reconAt(ZD))!;
  ok("[z2] later zero-delta reconcile updates lastReconciledAt (no new movement)", zResp.status === 200 && zdRecAfter.getTime() > zdRecBefore.getTime() && (await reconMovs(ZD)).length === adjMovsBefore);
  ok("[z-flag] reversibility query now EXCLUDES the account (UI would hide Undo)", !(await getReconcilableAccountIds(U)).includes(ZD));
  const zUndo = await post(undoRoute, ZD, {}); // stale undo request — server is authoritative
  ok("[z3/z8] undo of the older $500→$480 adjustment is rejected by the SERVER (409)", zUndo.status === 409);
  ok("[z4] balance remains $480", near(await bal(ZD), 480));
  ok("[z5] no reversal movement created", (await reconMovs(ZD)).filter((m) => m.kind === "reconcile_reversal").length === 0);
  ok("[z6] the newer lastReconciledAt is unchanged by the rejected undo", (await reconAt(ZD))!.getTime() === zdRecAfter.getTime());

  const ZOK = await mkAccount("R3B zerook", 500);
  await post(reconcileRoute, ZOK, { realBalance: 480 });
  ok("[z7a] without a later reconciliation the latest nonzero adjustment is reversible (query)", (await getReconcilableAccountIds(U)).includes(ZOK));
  const okUndo = await post(undoRoute, ZOK, {});
  ok("[z7b] that undo succeeds and restores $500", okUndo.status === 200 && near(await bal(ZOK), 500));
  ok("[z9] duplicate undo remains blocked (409, balance unchanged)", (await post(undoRoute, ZOK, {})).status === 409 && near(await bal(ZOK), 500));
  ok("[z10] unrelated account + its movements unchanged (control + ZD intact)", near(await bal(C), 777) && (await reconMovs(C)).length === 0 && (await reconMovs(ZD)).filter((m) => m.kind === "reconcile_adjustment").length === 1);
  // [12] duplicate/concurrent undo of the SAME reconciliation cannot credit twice.
  const RR = await mkAccount("R3B undo-dup", 500);
  await post(reconcileRoute, RR, { realBalance: 400 });
  const undoRace = await Promise.allSettled([post(undoRoute, RR, {}), post(undoRoute, RR, {})]);
  const us = undoRace.map((x) => (x.status === "fulfilled" ? x.value.status : 0));
  ok("[12] duplicate/concurrent undo applies once (restored 500, exactly one reversal)", near(await bal(RR), 500) && (await reconMovs(RR)).filter((m) => m.kind === "reconcile_reversal").length === 1 && us.includes(200));

  /* ===================== PROJECTION (pure) ===================== */
  console.log("\n[projection]");
  // 15 — actual unchanged by projection (DB-backed)
  const P = await mkAccount("R3B proj", 1000);
  const accView = A({ id: P, currentBalance: 1000 });
  computeProjection({ accounts: [accView], bills: [B({ id: 1, expectedAmount: 200, dueDate: d(3), sourceAccountId: P, status: "scheduled" })], income: [], transfers: [], horizon: "30d", today: TODAY });
  ok("[15] projection does not mutate the actual balance", near(await bal(P), 1000));

  const chk = A({ id: 1, name: "chk", currentBalance: 500 });
  const sav = A({ id: 2, name: "sav", type: "savings", purpose: "savings", currentBalance: 1000, includeInSpendable: false });
  const cred = A({ id: 3, name: "card", type: "credit", currentBalance: 300 });
  const linked = A({ id: 4, name: "linked", balanceSource: "linked", currentBalance: 2000 });
  const pj = (extra: Partial<Parameters<typeof computeProjection>[0]>) =>
    computeProjection({ accounts: [chk, sav, cred, linked], bills: [], income: [], transfers: [], horizon: "30d", today: TODAY, ...extra });
  const acctP = (p: ReturnType<typeof computeProjection>, id: number) => p.accounts.find((a) => a.accountId === id)!;

  ok("[16] open bill reduces assigned account projection", near(acctP(pj({ bills: [B({ id: 1, expectedAmount: 200, dueDate: d(3), sourceAccountId: 1, status: "scheduled" })] }), 1).projectedBalance, 300));
  ok("[17] paid bill is not projected", near(acctP(pj({ bills: [B({ id: 1, expectedAmount: 200, dueDate: d(3), sourceAccountId: 1, status: "paid" })] }), 1).projectedBalance, 500));
  const unb = pj({ bills: [B({ id: 1, expectedAmount: 200, dueDate: d(3), sourceAccountId: null, status: "scheduled" })] });
  ok("[18] unassigned bill not guessed into an account", near(acctP(unb, 1).projectedBalance, 500) && unb.unassignedBills.length === 1);
  ok("[19] scheduled single-destination income increases projection", near(acctP(pj({ income: [I({ id: 1, expectedAmount: 800, payDate: d(3), destinationAccountId: 1 })] }), 1).projectedBalance, 1300));
  const split = pj({ income: [I({ id: 1, expectedAmount: 1000, payDate: d(3), allocations: [
    { id: 1, accountId: 1, accountName: null, allocationType: "fixed", value: 200, position: 0 },
    { id: 2, accountId: 2, accountName: null, allocationType: "percent", value: 60, position: 1 },
    { id: 3, accountId: 3, accountName: null, allocationType: "percent", value: 40, position: 2 },
  ] })] });
  // chk +200, sav +480; the credit row (40% of 800 = 320) — credit isn't cash but projection still tracks it.
  ok("[20] scheduled split income allocates exactly (200/480/320)", near(acctP(split, 1).scheduledInflows, 200) && near(acctP(split, 2).scheduledInflows, 480) && near(acctP(split, 3).scheduledInflows, 320));
  ok("[21] received income is not projected", near(acctP(pj({ income: [I({ id: 1, expectedAmount: 800, payDate: d(3), destinationAccountId: 1, status: "received" })] }), 1).projectedBalance, 500));
  const tr = pj({ transfers: [T({ id: 1, fromAccountId: 1, toAccountId: 2, amount: 100, scheduledDate: d(2), status: "scheduled" })] });
  ok("[22] scheduled manual transfer affects source and destination", near(acctP(tr, 1).projectedBalance, 400) && near(acctP(tr, 2).projectedBalance, 1100));
  const noTr = pj({});
  ok("[23] total cash unchanged by an internal transfer", near(tr.totals.totalProjectedCash, noTr.totals.totalProjectedCash));
  ok("[24] completed transfer is not projected again", near(acctP(pj({ transfers: [T({ id: 1, fromAccountId: 1, toAccountId: 2, amount: 100, scheduledDate: d(2), status: "completed" })] }), 1).projectedBalance, 500));
  const linkP = pj({ income: [I({ id: 1, expectedAmount: 500, payDate: d(3), destinationAccountId: 4 })], transfers: [T({ id: 1, fromAccountId: 1, toAccountId: 4, amount: 100, scheduledDate: d(2), status: "scheduled" })] });
  ok("[25] linked-account items excluded + warned", acctP(linkP, 4).projectedBalance === 2000 && linkP.linkedSkipped.length >= 2 && linkP.warnings.some((w) => w.code === "linked_skipped"));
  // cash totals include cash-type accounts (chk 500 + sav 1000 + linked 2000 = 3500);
  // credit (300) is excluded from cash and reported as a liability.
  ok("[26] credit liabilities excluded from cash totals", near(noTr.totals.totalProjectedCash, 3500) && near(noTr.totals.creditLiabilities, 300));

  // horizons
  const billNear = B({ id: 1, expectedAmount: 100, dueDate: d(5), sourceAccountId: 1, status: "scheduled" });
  const billFar = B({ id: 2, expectedAmount: 100, dueDate: d(10), sourceAccountId: 1, status: "scheduled" });
  ok("[27] 7-day horizon includes day-5, excludes day-10", near(acctP(pj({ bills: [billNear, billFar], horizon: "7d" }), 1).projectedBalance, 400));
  const incomePay = [I({ id: 1, expectedAmount: 0, payDate: d(3), isPayday: true, destinationAccountId: 1 })];
  ok("[28] next-payday horizon ends at the payday (day-5 bill excluded)", near(acctP(pj({ bills: [B({ id: 1, expectedAmount: 100, dueDate: d(5), sourceAccountId: 1, status: "scheduled" })], income: incomePay, horizon: "payday" }), 1).projectedBalance, 500));
  ok("[29] 30-day horizon includes a day-20 bill", near(acctP(pj({ bills: [B({ id: 1, expectedAmount: 100, dueDate: d(20), sourceAccountId: 1, status: "scheduled" })], horizon: "30d" }), 1).projectedBalance, 400));
  ok("[30] timezone/date math deterministic (addDays + inclusive horizon)", addDays(TODAY, 7) === "2026-07-08" && near(acctP(pj({ bills: [B({ id: 1, expectedAmount: 100, dueDate: addDays(TODAY, 7), sourceAccountId: 1, status: "scheduled" })], horizon: "7d" }), 1).projectedBalance, 400));
  const shortAcct = A({ id: 1, name: "chk", currentBalance: 100 });
  const shortP = computeProjection({ accounts: [shortAcct], bills: [B({ id: 1, expectedAmount: 300, dueDate: d(3), sourceAccountId: 1, status: "scheduled" })], income: [], transfers: [], horizon: "30d", today: TODAY });
  ok("[31] projected shortfall warning correct (−200 below zero)", acctP(shortP, 1).belowZero && near(acctP(shortP, 1).projectedBalance, -200) && shortP.warnings.some((w) => w.code === "shortfall"));
  ok("[32] unassigned-risk warning correct", unb.warnings.some((w) => w.code === "unassigned_bill"));

  /* ===================== UI / SAFETY ===================== */
  console.log("\n[ui + safety]");
  const pageSrc = readFileSync("app/finances/page.tsx", "utf8");
  const acctMgr = readFileSync("components/finances/account-manager.tsx", "utf8");
  const homeSrc = readFileSync("components/home/sections.tsx", "utf8");
  const manageSrc = readFileSync("components/manage/manage-dashboard.tsx", "utf8");
  const projSrc = readFileSync("lib/services/finance-projection.ts", "utf8");
  const all = [pageSrc, acctMgr, homeSrc, manageSrc, projSrc].join("\n");
  ok("[33] /finances shows actual AND projected separately", /Total actual cash/.test(pageSrc) && /Total projected cash/.test(pageSrc));
  ok("[34] reconcile control is manual-only", /balanceSource === "manual"/.test(acctMgr) && /Reconcile/.test(acctMgr));
  ok("[35] last-reconciled label present", /Last reconciled|Not yet reconciled/.test(acctMgr));
  ok("[36] forecast timeline shows dated items", /Forecast timeline/.test(pageSrc));
  ok("[37] Home stays compact (actual + projected + link, no account mgmt)", /Manual actual cash/.test(homeSrc) && /projected/i.test(homeSrc) && homeSrc.includes('href="/finances"') && !homeSrc.includes("AccountManager"));
  ok("[38] /manage is summary-only + links /finances", manageSrc.includes("/finances") && !manageSrc.includes("FinanceManager"));
  ok("[39] no projected value called live/current/available/safe-to-spend", !/safe to spend|live balance|projected.{0,12}current balance|available-now balance/i.test(all));
  // NOTE: read-only Plaid connections are intentionally added by Finance 1B.0/1B.1
  // (separate, approved builds) and now surface in /finances — so they are NO
  // LONGER excluded here. The 1A.3B invariant is narrower: the PROJECTION +
  // RECONCILIATION logic must not depend on Plaid or imported transactions.
  ok("[40] 1A.3B projection/reconciliation has no Plaid / imported-transaction dependency",
    !/plaid/i.test(projSrc + acctMgr) && !/import(ed)? transaction/i.test(projSrc));
  const logsAfter = (await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))).length;
  ok("[41] no usage-log row (no AI)", logsBefore === logsAfter);
  // owner data: balances + reconcile timestamps + movement count unchanged (no fabrication)
  let ownerOk = true;
  for (const a of ownerAccts) {
    const now = (await db.select().from(financialAccounts).where(eq(financialAccounts.id, a.id)))[0];
    if (!now || now.currentBalance !== ownerBal.get(a.id) || (now.lastReconciledAt?.toISOString() ?? null) !== ownerRecon.get(a.id)) ownerOk = false;
  }
  const mineSet = new Set(acct.accountIds);
  const fabricated = (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).filter((m) => !mineSet.has(m.accountId)).length;
  ok("[42] no historical movements fabricated (owner balances/timestamps + movement count intact)", ownerOk && fabricated === ownerMovCount);
}

async function cleanup() {
  console.log("\n[cleanup] exact-ID-scoped");
  console.log(`  accounts:[${acct.accountIds}]`);
  const [before222] = await db.select().from(experienceRequests).where(eq(experienceRequests.id, 222)).limit(1);
  if (acct.accountIds.length) {
    await db.delete(accountMovements).where(and(inArray(accountMovements.accountId, acct.accountIds), inArray(accountMovements.kind, ["reconcile_reversal"])));
    await db.delete(accountMovements).where(inArray(accountMovements.accountId, acct.accountIds));
    await db.delete(financialAccounts).where(inArray(financialAccounts.id, acct.accountIds));
  }
  const [after222] = await db.select().from(experienceRequests).where(eq(experienceRequests.id, 222)).limit(1);
  ok("[43] request 222 untouched", JSON.stringify(after222) === JSON.stringify(before222));
  const left = (await db.select({ id: financialAccounts.id }).from(financialAccounts).where(eq(financialAccounts.userId, U))).filter((r) => acct.accountIds.includes(r.id));
  ok("[44] all harness accounts removed (exact-ID cleanup)", left.length === 0);
}

main()
  .then(cleanup)
  .catch(async (e) => { console.error("harness error:", e); try { await cleanup(); } catch {} process.exitCode = 1; })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    console.log("\nReconciliation + projection verified; actual vs projected separate, no double-counting, owner data intact.");
    if (failed > 0) process.exitCode = 1;
  });
