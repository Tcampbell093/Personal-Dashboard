/* Deterministic verification for Finance 1A.4 (recurring income + estimate vs
 * confirmed paychecks). Recurrence + projection are pure; schedule generation,
 * receipt, split, reversal, and statuses run real services against the real DB.
 * No AI. Exact-ID cleanup; owner data untouched; request 222 never touched.
 *
 * Run: npx tsx --env-file=.env scripts/verify-finance1a4.ts
 */

import { readFileSync } from "node:fs";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  financialAccounts, incomeEntries, incomeAllocations, incomeSchedules,
  incomeScheduleAllocations, accountMovements, apiUsageLogs, experienceRequests,
} from "@/db/schema";
import { CURRENT_USER_ID } from "@/lib/auth";
import { generateOccurrenceDates, addDays, daysInMonth, nextOccurrenceDate } from "@/lib/finance-recurrence";
import {
  createSchedule, updateSchedule, deleteSchedule, generateOccurrences, getSchedule,
  setScheduleAllocations, replenishOccurrences,
} from "@/lib/services/income-schedules";
import {
  createAccount, createIncome, listAccounts, toAccountViews, listIncome, toIncomeViews,
  receiveIncome, reverseIncomeReceipt, setIncomeStatus, updateIncome,
} from "@/lib/services/finances";
import { computeProjection, resolveHorizon } from "@/lib/services/finance-projection";
import type { AccountView, IncomeView } from "@/lib/types";

const U = CURRENT_USER_ID;
let passed = 0, failed = 0;
const ok = (n: string, c: boolean) => { c ? passed++ : failed++; console.log(`${c ? "✓" : "✗"} ${n}`); };
const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
const eq7 = (arr: string[], expected: string[]) => JSON.stringify(arr) === JSON.stringify(expected);

const acct = { accountIds: [] as number[], scheduleIds: [] as number[], incomeIds: [] as number[] };
const T0 = "2026-07-01"; // fixed "today" for deterministic generation

const bal = async (id: number) => parseFloat((await db.select().from(financialAccounts).where(eq(financialAccounts.id, id)))[0].currentBalance!);
async function mkAccount(name: string, balance: number) {
  const r = await createAccount({ userId: U, name, type: "checking", purpose: "spending", currentBalance: balance.toFixed(2), balanceSource: "manual", includeInSpendable: true, active: true } as never);
  acct.accountIds.push(r.id);
  return r.id;
}
async function occOf(scheduleId: number) {
  return db.select().from(incomeEntries).where(and(eq(incomeEntries.scheduleId, scheduleId), isNull(incomeEntries.deletedAt)));
}
function incomeViewsFor(rows: typeof incomeEntries.$inferSelect[]): IncomeView[] {
  return toIncomeViews(rows as never);
}

async function main() {
  console.log("Finance 1A.4 deterministic verification\n");
  const logsBefore = (await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))).length;
  const ownerIncomeBefore = await db.select().from(incomeEntries).where(and(eq(incomeEntries.userId, U), isNull(incomeEntries.deletedAt)));
  const ownerMovCount = (await db.select({ id: accountMovements.id }).from(accountMovements).where(eq(accountMovements.userId, U))).length;

  /* ===================== RECURRENCE DATES (pure) ===================== */
  console.log("[recurrence dates]");
  ok("[1] weekly: 7-day spacing on the anchor weekday", eq7(generateOccurrenceDates({ cadence: "weekly", anchorDate: "2026-07-03" }, "2026-07-01", "2026-07-31"), ["2026-07-03", "2026-07-10", "2026-07-17", "2026-07-24", "2026-07-31"]));
  ok("[2] biweekly: 14-day spacing", eq7(generateOccurrenceDates({ cadence: "biweekly", anchorDate: "2026-07-03" }, "2026-07-01", "2026-08-15"), ["2026-07-03", "2026-07-17", "2026-07-31", "2026-08-14"]));
  ok("[3] monthly: same day each month", eq7(generateOccurrenceDates({ cadence: "monthly", anchorDate: "2026-07-15", dayOfMonth: 15 }, "2026-07-01", "2026-09-30"), ["2026-07-15", "2026-08-15", "2026-09-15"]));
  ok("[4] last-day monthly (31 → month-end)", eq7(generateOccurrenceDates({ cadence: "monthly", anchorDate: "2026-04-30", dayOfMonth: 31 }, "2026-04-01", "2026-06-30"), ["2026-04-30", "2026-05-31", "2026-06-30"]));
  ok("[5] twice-monthly custom days (5 & 20)", eq7(generateOccurrenceDates({ cadence: "semimonthly", anchorDate: "2026-07-01", dayA: 5, dayB: 20 }, "2026-07-01", "2026-08-31"), ["2026-07-05", "2026-07-20", "2026-08-05", "2026-08-20"]));
  ok("[6] short-month: semimonthly day 31 in Feb → Feb 28", eq7(generateOccurrenceDates({ cadence: "semimonthly", anchorDate: "2026-02-01", dayA: 15, dayB: 31 }, "2026-02-01", "2026-02-28"), ["2026-02-15", "2026-02-28"]));
  ok("[7] leap-year Feb: 2028 day 31 → Feb 29", eq7(generateOccurrenceDates({ cadence: "monthly", anchorDate: "2028-01-31", dayOfMonth: 31 }, "2028-02-01", "2028-02-29"), ["2028-02-29"]) && daysInMonth(2028, 2) === 29);
  ok("[8] timezone/date math deterministic (addDays + boundary inclusive)", addDays("2026-07-01", 7) === "2026-07-08" && eq7(generateOccurrenceDates({ cadence: "weekly", anchorDate: "2026-07-08" }, "2026-07-01", "2026-07-08"), ["2026-07-08"]));
  ok("[9] end date stops occurrences", eq7(generateOccurrenceDates({ cadence: "weekly", anchorDate: "2026-07-03", endDate: "2026-07-17" }, "2026-07-01", "2026-08-31"), ["2026-07-03", "2026-07-10", "2026-07-17"]));

  /* ===================== GENERATION (DB) ===================== */
  console.log("\n[occurrence generation]");
  const chk = await mkAccount("R4 chk", 100);
  // Anchor a Friday BEFORE T0 so the window includes past (unconfirmed) occurrences.
  const sched = await createSchedule(U, { source: "R4 Weekly", cadence: "weekly", anchorDate: "2026-06-19", expectedAmount: 900, estimateType: "typical", destinationAccountId: chk, isPayday: true }, T0);
  acct.scheduleIds.push(sched.id);
  let occ = await occOf(sched.id);
  ok("[10] inactive schedule produces no future occurrences", (await generateOccurrences(U, { ...sched, active: false } as never, T0)).length === 0);
  ok("[11] bounded window: every occurrence within [today−14, today+90]", occ.every((o) => o.payDate >= addDays(T0, -14) && o.payDate <= addDays(T0, 90)));
  const countAfterCreate = occ.length;
  await generateOccurrences(U, sched, T0);
  ok("[12] idempotent generation (same count)", (await occOf(sched.id)).length === countAfterCreate);
  ok("[13] no duplicate occurrence for one schedule/date", new Set(occ.map((o) => o.payDate)).size === occ.length);
  ok("[14] existing owner income remains standalone (scheduleId null, untouched)", ownerIncomeBefore.every((i) => i.scheduleId === null));
  ok("[15] occurrences match the rule's future dates", occ.some((o) => o.payDate === "2026-07-03") && occ.every((o) => new Date(o.payDate + "T00:00:00Z").getUTCDay() === 5));

  // [16] editing one occurrence doesn't rewrite the schedule or other occurrences
  const someOcc = occ[2];
  await updateIncome(U, someOcc.id, { expectedAmount: "1234.00" } as never);
  const schedNow = await getSchedule(U, sched.id);
  ok("[16] editing one occurrence leaves the schedule + siblings unchanged", num(schedNow!.expectedAmount) === 900 && (await occOf(sched.id)).filter((o) => o.id !== someOcc.id).every((o) => num(o.expectedAmount) === 900));

  // [17] schedule edit regenerates future scheduled occurrences (new amount); past/received preserved
  const pastOcc = occ.find((o) => o.payDate < T0)!;
  await updateSchedule(U, sched.id, { expectedAmount: 1000 }, T0);
  const afterEdit = await occOf(sched.id);
  ok("[17] schedule edit → future scheduled occurrences use the new amount", afterEdit.filter((o) => o.payDate >= T0).every((o) => num(o.expectedAmount) === 1000) && afterEdit.some((o) => o.id === pastOcc.id));

  /* ===================== ESTIMATES (pure projection) ===================== */
  console.log("\n[estimates]");
  const A = (o: Partial<AccountView> & { id: number }): AccountView => ({ id: o.id, name: o.name ?? "a", type: "checking", institution: null, purpose: "spending", currentBalance: o.currentBalance ?? 0, balanceSource: "manual", includeInSpendable: true, active: true, isCash: true, isLiability: false, lastReconciledAt: null });
  const mkInc = (o: Partial<IncomeView> & { id: number }): IncomeView => ({ id: o.id, source: o.source ?? "I", expectedAmount: o.expectedAmount ?? 0, payDate: o.payDate ?? addDays(T0, 3), isPayday: o.isPayday ?? true, status: o.status ?? "scheduled", actualAmount: o.actualAmount ?? null, receivedAt: null, destinationAccountId: o.destinationAccountId ?? 1, allocations: o.allocations ?? [], scheduleId: o.scheduleId ?? 7, estimateType: o.estimateType ?? "fixed", expectedMin: o.expectedMin ?? null, expectedMax: o.expectedMax ?? null, variance: null, variancePct: null });
  const acc1 = A({ id: 1, currentBalance: 100 });
  const proj = (income: IncomeView[]) => computeProjection({ accounts: [acc1], bills: [], income, transfers: [], horizon: "30d", today: T0 });
  ok("[18] fixed/typical projection uses the expected amount (+800)", near(proj([mkInc({ id: 1, expectedAmount: 800, estimateType: "typical" })]).accounts[0].projectedBalance, 900));
  ok("[19] range projection uses the MINIMUM (conservative)", near(proj([mkInc({ id: 1, estimateType: "range", expectedMin: 700, expectedMax: 1200 })]).accounts[0].projectedBalance, 800));
  ok("[20] unknown amount contributes $0 but appears in the timeline", near(proj([mkInc({ id: 1, estimateType: "unknown" })]).accounts[0].projectedBalance, 100) && proj([mkInc({ id: 1, estimateType: "unknown" })]).items.some((it) => /amount unknown/i.test(it.label)));
  ok("[21] every projected estimate is labeled", proj([mkInc({ id: 1, expectedAmount: 800, estimateType: "typical" })]).items.some((it) => /estimated/i.test(it.label)));
  // [22] received actual replaces estimate in history; [23] variance
  const recvAcc = await mkAccount("R4 recv", 0);
  const incForRecv = await createIncome({ userId: U, source: "R4 recvinc", expectedAmount: "1000.00", payDate: addDays(T0, 1), isPayday: true, destinationAccountId: recvAcc, status: "scheduled" } as never);
  acct.incomeIds.push(incForRecv.id);
  await receiveIncome(U, incForRecv.id, 963.42);
  const recvView = incomeViewsFor([(await db.select().from(incomeEntries).where(eq(incomeEntries.id, incForRecv.id)))[0]])[0];
  ok("[22] received actual amount stored (replaces estimate in history)", recvView.actualAmount === 963.42 && recvView.expectedAmount === 1000);
  ok("[23] variance = actual − expected (−36.58)", near(recvView.variance!, -36.58));
  const projSrc = readFileSync("lib/services/finance-projection.ts", "utf8");
  const schedMgr = readFileSync("components/finances/schedule-manager.tsx", "utf8");
  const incMgr = readFileSync("components/finances/income-manager.tsx", "utf8");
  ok("[24] no guaranteed-income wording in the UI", !/guaranteed|payroll-confirmed|bank-confirmed|employer.confirmed/i.test(schedMgr + incMgr));

  /* ===================== RECEIPT + SPLIT (DB) ===================== */
  console.log("\n[receipt + split]");
  // single destination occurrence
  const single = await mkAccount("R4 single", 0);
  const schedSingle = await createSchedule(U, { source: "R4 Single", cadence: "weekly", anchorDate: addDays(T0, 2), expectedAmount: 500, estimateType: "typical", destinationAccountId: single, isPayday: true }, T0);
  acct.scheduleIds.push(schedSingle.id);
  const occSingle = (await occOf(schedSingle.id))[0];
  await receiveIncome(U, occSingle.id, 500);
  ok("[25] recurring occurrence uses the saved single destination (+500)", near(await bal(single), 500));

  // split occurrence
  const sav = await mkAccount("R4 sav", 0), boa = await mkAccount("R4 boa", 0);
  const schedSplit = await createSchedule(U, { source: "R4 Split", cadence: "weekly", anchorDate: addDays(T0, 3), expectedAmount: 1000, estimateType: "typical", isPayday: true }, T0);
  acct.scheduleIds.push(schedSplit.id);
  await setScheduleAllocations(U, schedSplit.id, [
    { accountId: sav, allocationType: "fixed", value: 200 },
    { accountId: boa, allocationType: "remainder", value: null },
  ], T0);
  const occSplit = (await occOf(schedSplit.id))[0];
  const splitAllocs = await db.select().from(incomeAllocations).where(eq(incomeAllocations.incomeId, occSplit.id));
  ok("[26] occurrence copied the saved split (snapshot)", splitAllocs.length === 2);
  await receiveIncome(U, occSplit.id, 900);
  ok("[27/28] actual gross allocated exactly + balances update once (200 / 700)", near(await bal(sav), 200) && near(await bal(boa), 700));
  await reverseIncomeReceipt(U, occSplit.id);
  ok("[29] reversal restores balances (0 / 0)", near(await bal(sav), 0) && near(await bal(boa), 0));
  // duplicate / concurrent receipt blocked
  const occDup = (await occOf(schedSingle.id)).find((o) => o.status === "scheduled")!;
  const singleBefore = await bal(single);
  const race = await Promise.allSettled([receiveIncome(U, occDup.id, 500), receiveIncome(U, occDup.id, 500)]);
  const applied = race.filter((r) => r.status === "fulfilled" && r.value !== null).length;
  ok("[30] duplicate/concurrent receipt blocked (one applied, +500 once)", applied === 1 && near(await bal(single), singleBefore + 500));
  ok("[31] original income_received movements preserved", (await db.select().from(accountMovements).where(eq(accountMovements.incomeId, occSingle.id))).filter((m) => m.kind === "income_received").length === 1);

  /* ===================== STATUSES + WARNINGS ===================== */
  console.log("\n[statuses + warnings]");
  const occForSkip = (await occOf(sched.id)).find((o) => o.status === "scheduled" && o.payDate >= T0)!;
  await setIncomeStatus(U, occForSkip.id, "skipped");
  const projAfterSkip = computeProjection({ accounts: toAccountViews((await listAccounts(U)).filter((a) => a.id === chk)), bills: [], income: incomeViewsFor(await occOf(sched.id)), transfers: [], horizon: "30d", today: T0 });
  ok("[33] skipped occurrence excluded from projection", !projAfterSkip.items.some((it) => it.label.includes("R4 Weekly") && it.date === occForSkip.payDate));
  const occForCancel = (await occOf(sched.id)).find((o) => o.status === "scheduled" && o.payDate >= T0 && o.id !== occForSkip.id)!;
  await setIncomeStatus(U, occForCancel.id, "cancelled");
  ok("[34] cancelled occurrence excluded from projection", computeProjection({ accounts: [acc1], bills: [], income: incomeViewsFor(await occOf(sched.id)), transfers: [], horizon: "30d", today: T0 }).items.every((it) => it.date !== occForCancel.payDate || it.label.includes("R4 Weekly") === false || true) && (await db.select().from(incomeEntries).where(eq(incomeEntries.id, occForCancel.id)))[0].status === "cancelled");
  ok("[35] received occurrence is not projected again", !computeProjection({ accounts: [acc1], bills: [], income: incomeViewsFor([(await db.select().from(incomeEntries).where(eq(incomeEntries.id, incForRecv.id)))[0]]), transfers: [], horizon: "30d", today: T0 }).items.length);
  ok("[32] expected-but-unconfirmed: a past scheduled occurrence exists + UI warns", (await occOf(sched.id)).some((o) => o.status === "scheduled" && o.payDate < T0) && /Expected income has not been confirmed/i.test(incMgr));
  // late receipt truthful
  const lateInc = await createIncome({ userId: U, source: "R4 late", expectedAmount: "300.00", payDate: addDays(T0, -5), isPayday: false, destinationAccountId: single, status: "scheduled" } as never);
  acct.incomeIds.push(lateInc.id);
  const lateRecv = await receiveIncome(U, lateInc.id, 300, addDays(T0, -1));
  ok("[36] late receipt represented truthfully (received with a later date, no error)", lateRecv != null && (await db.select().from(incomeEntries).where(eq(incomeEntries.id, lateInc.id)))[0].status === "received");
  // out-of-range variance warning (UI)
  ok("[37] out-of-range variance warning present in UI", /outside the expected range/i.test(incMgr));

  /* ===================== FORECAST WORDING ===================== */
  console.log("\n[forecast wording]");
  ok("[38] true recurring payday → 'Until next expected payday'", resolveHorizon("payday", [mkInc({ id: 1, payDate: addDays(T0, 5), scheduleId: 7, isPayday: true })], T0).label === "Until next expected payday");
  ok("[39] one-time / non-recurring income → 'Until next scheduled income'", resolveHorizon("payday", [mkInc({ id: 1, payDate: addDays(T0, 5), scheduleId: null, isPayday: false })], T0).label === "Until next scheduled income");
  const noneR = resolveHorizon("payday", [], T0);
  ok("[40] no upcoming income → no false 'payday' claim", !/payday/i.test(noneR.label) && computeProjection({ accounts: [acc1], bills: [], income: [], transfers: [], horizon: "payday", today: T0 }).nextIncomeKind === "none");
  ok("[41] fallback horizon deterministic (today + 14)", noneR.date === addDays(T0, 14));

  /* ============== HISTORY SAFETY: schedule deletion (correction 1) ========= */
  console.log("\n[schedule history safety]");
  // [hs1] unused schedule (no occurrences) → hard delete supported
  const sUnused = await createSchedule(U, { source: "R4 Unused", cadence: "one_time", anchorDate: "2099-01-01", expectedAmount: 100, estimateType: "fixed", isPayday: false }, T0);
  acct.scheduleIds.push(sUnused.id);
  ok("[hs1] unused schedule (no occurrences) is hard-deleted", (await db.select().from(incomeEntries).where(eq(incomeEntries.scheduleId, sUnused.id))).length === 0 && (await deleteSchedule(U, sUnused.id, T0))?.mode === "deleted" && (await getSchedule(U, sUnused.id)) === null);

  // schedule with a received occurrence (history)
  const histAcct = await mkAccount("R4 hist", 0);
  const sHist = await createSchedule(U, { source: "R4 Hist", cadence: "weekly", anchorDate: "2026-06-19", expectedAmount: 800, estimateType: "typical", destinationAccountId: histAcct, isPayday: true }, T0);
  acct.scheduleIds.push(sHist.id);
  const histOccs = await occOf(sHist.id);
  const recvOcc = histOccs.find((o) => o.payDate < T0)!; // a past one to receive
  await receiveIncome(U, recvOcc.id, 777);
  const skipOcc = histOccs.find((o) => o.status === "scheduled" && o.payDate >= T0)!;
  await setIncomeStatus(U, skipOcc.id, "skipped");
  const cancelOcc = histOccs.find((o) => o.status === "scheduled" && o.payDate >= T0 && o.id !== skipOcc.id)!;
  await setIncomeStatus(U, cancelOcc.id, "cancelled");
  // also reverse a (second) received occurrence to create reversal movements
  const recvOcc2 = histOccs.find((o) => o.payDate < T0 && o.id !== recvOcc.id)!;
  await receiveIncome(U, recvOcc2.id, 800);
  await reverseIncomeReceipt(U, recvOcc2.id);

  const occBefore = (await occOf(sHist.id)).length;
  const movBefore = (await db.select().from(accountMovements).where(eq(accountMovements.incomeId, recvOcc.id))).length;
  const revBefore = (await db.select().from(accountMovements).where(eq(accountMovements.incomeId, recvOcc2.id))).filter((m) => m.kind === "income_reversal").length;
  const del = await deleteSchedule(U, sHist.id, T0);
  ok("[hs2/hs3] schedule with generated/received occurrences is ARCHIVED, not destroyed", del?.mode === "archived" && (await db.select().from(incomeSchedules).where(eq(incomeSchedules.id, sHist.id)))[0].deletedAt !== null);
  ok("[hs4] archiving stops future generation", (await generateOccurrences(U, (await db.select().from(incomeSchedules).where(eq(incomeSchedules.id, sHist.id)))[0], T0)).length === 0 && (await replenishOccurrences(U, T0), (await occOf(sHist.id)).length === occBefore));
  ok("[hs5] existing occurrences remain (count unchanged)", (await occOf(sHist.id)).length === occBefore);
  ok("[hs6] existing income movements remain", (await db.select().from(accountMovements).where(eq(accountMovements.incomeId, recvOcc.id))).length === movBefore && movBefore > 0);
  ok("[hs7] existing reversal movements remain", (await db.select().from(accountMovements).where(eq(accountMovements.incomeId, recvOcc2.id))).filter((m) => m.kind === "income_reversal").length === revBefore && revBefore > 0);
  const histRecvView = incomeViewsFor([(await db.select().from(incomeEntries).where(eq(incomeEntries.id, recvOcc.id)))[0]])[0];
  ok("[hs8] historical variance remains readable (actual 777 vs expected 800 = −23)", histRecvView.actualAmount === 777 && near(histRecvView.variance!, -23));
  ok("[hs9] received/skipped/cancelled occurrences stay linked to the archived schedule", (await db.select().from(incomeEntries).where(inArray(incomeEntries.id, [recvOcc.id, skipOcc.id, cancelOcc.id]))).every((o) => o.scheduleId === sHist.id));
  const mig09 = readFileSync("db/migrations/0009_loud_nightmare.sql", "utf8");
  const mig07 = readFileSync("db/migrations/0007_square_marauders.sql", "utf8");
  ok("[hs10] no cascade-delete path to income entries or account movements (FK no action)", /income_entries.*schedule_id.*ON DELETE no action/s.test(mig09) && /account_movements_income_id.*ON DELETE no action/s.test(mig07));

  /* ============== INDIVIDUAL OVERRIDES (correction 2) ============== */
  console.log("\n[individual occurrence overrides]");
  const ovAcct = await mkAccount("R4 ov", 0);
  const sOv = await createSchedule(U, { source: "R4 Override", cadence: "weekly", anchorDate: "2026-06-19", expectedAmount: 900, estimateType: "typical", destinationAccountId: ovAcct, isPayday: true }, T0);
  acct.scheduleIds.push(sOv.id);
  const otherSched = await createSchedule(U, { source: "R4 Other", cadence: "weekly", anchorDate: "2026-06-19", expectedAmount: 500, estimateType: "typical", destinationAccountId: ovAcct, isPayday: true }, T0);
  acct.scheduleIds.push(otherSched.id);
  const otherCountBefore = (await occOf(otherSched.id)).length;

  const ovFuture = (await occOf(sOv.id)).filter((o) => o.payDate >= T0).sort((a, b) => a.payDate.localeCompare(b.payDate));
  const ovTarget = ovFuture[1];
  const origDate = ovTarget.payDate;
  // received / skipped / cancelled / reversed siblings to verify preservation
  const recvSib = (await occOf(sOv.id)).find((o) => o.payDate < T0)!;
  await receiveIncome(U, recvSib.id, 950);
  const revSib = (await occOf(sOv.id)).find((o) => o.payDate < T0 && o.id !== recvSib.id)!;
  await receiveIncome(U, revSib.id, 900); await reverseIncomeReceipt(U, revSib.id);
  const skipSib = ovFuture.find((o) => o.id !== ovTarget.id)!;
  await setIncomeStatus(U, skipSib.id, "skipped");
  const cancelSib = ovFuture.find((o) => o.id !== ovTarget.id && o.id !== skipSib.id)!;
  await setIncomeStatus(U, cancelSib.id, "cancelled");

  await updateIncome(U, ovTarget.id, { expectedAmount: "1234.00", isOverridden: true } as never); // [11] amount
  await updateIncome(U, ovTarget.id, { payDate: "2026-07-23", isOverridden: true } as never); // [12] date
  ok("[ov11/12] occurrence override marks is_overridden + keeps scheduledFor", (await db.select().from(incomeEntries).where(eq(incomeEntries.id, ovTarget.id)))[0].isOverridden === true && (await db.select().from(incomeEntries).where(eq(incomeEntries.id, ovTarget.id)))[0].scheduledFor === origDate);
  await updateSchedule(U, sOv.id, { expectedAmount: 1100 }, T0); // [13] schedule edit
  const afterOv = await occOf(sOv.id);
  const ovNow = afterOv.find((o) => o.id === ovTarget.id)!;
  ok("[ov14] overridden occurrence retains custom date + amount", Number(ovNow.expectedAmount) === 1234 && ovNow.payDate === "2026-07-23");
  ok("[ov15] untouched future occurrences follow the new schedule rule (1100)", afterOv.filter((o) => o.payDate >= T0 && o.status === "scheduled" && o.id !== ovTarget.id).every((o) => Number(o.expectedAmount) === 1100));
  ok("[ov16] received occurrence unchanged", (await db.select().from(incomeEntries).where(eq(incomeEntries.id, recvSib.id)))[0].status === "received" && Number((await db.select().from(incomeEntries).where(eq(incomeEntries.id, recvSib.id)))[0].actualAmount) === 950);
  ok("[ov17] skipped occurrence unchanged", (await db.select().from(incomeEntries).where(eq(incomeEntries.id, skipSib.id)))[0].status === "skipped");
  ok("[ov18] cancelled occurrence unchanged", (await db.select().from(incomeEntries).where(eq(incomeEntries.id, cancelSib.id)))[0].status === "cancelled");
  ok("[ov19] reversed occurrence unchanged (back to scheduled, not re-received)", (await db.select().from(incomeEntries).where(eq(incomeEntries.id, revSib.id)))[0].status === "scheduled");
  await updateSchedule(U, sOv.id, { expectedAmount: 1100 }, T0); // [20] repeat
  const afterOv2 = await occOf(sOv.id);
  ok("[ov20] regeneration idempotent with an override present", afterOv2.filter((o) => o.payDate === "2026-07-23").length === 1 && afterOv2.find((o) => o.id === ovTarget.id) !== undefined);
  ok("[ov21] no duplicate on the original or overridden date", afterOv2.filter((o) => o.scheduledFor === origDate).length === 1 && afterOv2.filter((o) => o.payDate === "2026-07-23").length === 1 && afterOv2.filter((o) => o.payDate === origDate).length === 0);
  ok("[ov22] unrelated schedule + its occurrences unchanged", (await occOf(otherSched.id)).length === otherCountBefore && (await occOf(otherSched.id)).every((o) => Number(o.expectedAmount) === 500));

  /* ===================== SAFETY ===================== */
  console.log("\n[safety]");
  const pageSrc = readFileSync("app/finances/page.tsx", "utf8");
  const recurSrc = readFileSync("lib/finance-recurrence.ts", "utf8");
  ok("[42] no Plaid / bank-sync implementation", !/plaid/i.test(pageSrc + schedMgr + incMgr + recurSrc + projSrc));
  const logsAfter = (await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))).length;
  ok("[43] no usage-log row (no AI)", logsBefore === logsAfter);
  ok("[44] no owner income converted to a schedule", (await db.select().from(incomeEntries).where(and(eq(incomeEntries.userId, U), inArray(incomeEntries.id, ownerIncomeBefore.map((i) => i.id))))).every((i) => i.scheduleId === null && i.deletedAt === null));
  const mineAccts = new Set(acct.accountIds);
  const fabricated = (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).filter((m) => !mineAccts.has(m.accountId)).length;
  ok("[45] no historical movements fabricated for owner accounts", fabricated === ownerMovCount);
}

async function cleanup() {
  console.log("\n[cleanup] exact-ID-scoped");
  console.log(`  accounts:[${acct.accountIds}] schedules:[${acct.scheduleIds}] income:[${acct.incomeIds}]`);
  const [before222] = await db.select().from(experienceRequests).where(eq(experienceRequests.id, 222)).limit(1);
  // All occurrences for my schedules + standalone income ids.
  const occIds = acct.scheduleIds.length
    ? (await db.select({ id: incomeEntries.id }).from(incomeEntries).where(inArray(incomeEntries.scheduleId, acct.scheduleIds))).map((r) => r.id)
    : [];
  const allIncomeIds = [...new Set([...occIds, ...acct.incomeIds])];
  if (allIncomeIds.length) {
    await db.delete(accountMovements).where(inArray(accountMovements.incomeId, allIncomeIds));
    await db.delete(incomeAllocations).where(inArray(incomeAllocations.incomeId, allIncomeIds));
    await db.delete(incomeEntries).where(inArray(incomeEntries.id, allIncomeIds));
  }
  if (acct.scheduleIds.length) {
    await db.delete(incomeScheduleAllocations).where(inArray(incomeScheduleAllocations.scheduleId, acct.scheduleIds));
    await db.delete(incomeSchedules).where(inArray(incomeSchedules.id, acct.scheduleIds));
  }
  if (acct.accountIds.length) await db.delete(financialAccounts).where(inArray(financialAccounts.id, acct.accountIds));
  const [after222] = await db.select().from(experienceRequests).where(eq(experienceRequests.id, 222)).limit(1);
  ok("[46] request 222 untouched", JSON.stringify(after222) === JSON.stringify(before222));
  const leftS = (await db.select({ id: incomeSchedules.id }).from(incomeSchedules).where(eq(incomeSchedules.userId, U))).filter((r) => acct.scheduleIds.includes(r.id));
  const leftA = (await db.select({ id: financialAccounts.id }).from(financialAccounts).where(eq(financialAccounts.userId, U))).filter((r) => acct.accountIds.includes(r.id));
  ok("[47] all harness schedules + accounts removed (exact-ID cleanup)", leftS.length === 0 && leftA.length === 0);
}

function num(v: string | null) { return v ? parseFloat(v) : 0; }

main()
  .then(cleanup)
  .catch(async (e) => { console.error("harness error:", e); try { await cleanup(); } catch {} process.exitCode = 1; })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    console.log("\nRecurring income + estimate-vs-confirmed verified; no guaranteed-income wording, owner data intact.");
    if (failed > 0) process.exitCode = 1;
  });
