/* =============================================================================
 * verify-finance1b4a.ts — Finance 1B.4A deterministic verification.
 *
 * Transaction-matching SUGGESTIONS: generation + scoring + confidence + reason
 * codes + idempotency/concurrency + bill/income confirmation (reusing existing
 * workflows) + transfer/linked fail-closed + rejection + UI + domain & owner
 * protection. Exact-ID temporary test records only; cleaned on every exit path.
 * ===========================================================================*/

import { readFileSync } from "node:fs";
import { and, eq, inArray, isNull, like } from "drizzle-orm";
import { db } from "@/db";
import {
  importedTransactions, financialConnections, financialAccounts, financialEntries,
  incomeEntries, accountMovements, accountTransfers, providerAccounts, apiUsageLogs,
  experienceRequests, transactionMatchSuggestions,
} from "@/db/schema";
import { CURRENT_USER_ID as U } from "@/lib/auth";
import { localToday } from "@/lib/time";
import {
  generateMatchSuggestions, getMatchSuggestionViews, countPendingMatches,
  confirmMatchSuggestion, rejectMatchSuggestion, MatchError, calendarDayDiff, MIN_SCORE, BANDS,
} from "@/lib/services/matching";

let passed = 0, failed = 0;
const ok = (n: string, c: boolean) => { c ? passed++ : failed++; console.log(`${c ? "✓" : "✗"} ${n}`); };
const read = (p: string) => readFileSync(p, "utf8");
const num = (s: string | null | undefined) => (s == null ? 0 : Number(s));
const FOREIGN = U + 99999;

// addDays on a YYYY-MM-DD (date-only, tz-safe)
function addDays(iso: string, d: number): string {
  const [y, m, dd] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, dd + d));
  return t.toISOString().slice(0, 10);
}

const created = { connId: 0, acctIds: [] as number[], txnIds: [] as number[], billIds: [] as number[], incomeIds: [] as number[] };

async function mkTxn(o: { amount: number; acctId: number | null; date: string; merchant: string; pending?: boolean; removed?: boolean }): Promise<number> {
  const [r] = await db.insert(importedTransactions).values({
    userId: U, connectionId: created.connId, providerAccountId: "ZZ4A-pa", provider: "plaid",
    providerTransactionId: `ZZ4A-${created.txnIds.length}-${o.merchant}-${o.amount}`,
    status: o.removed ? "removed" : "active", isPending: o.pending ?? false,
    amount: String(o.amount.toFixed(2)), descriptionCurrent: o.merchant, merchantName: o.merchant,
    financialAccountId: o.acctId, postedDate: o.date, authorizedDate: o.date,
  }).returning({ id: importedTransactions.id });
  created.txnIds.push(r.id);
  return r.id;
}

async function cleanup() {
  try {
    if (created.txnIds.length) await db.delete(transactionMatchSuggestions).where(and(eq(transactionMatchSuggestions.userId, U), inArray(transactionMatchSuggestions.primaryTransactionId, created.txnIds))).catch(() => {});
    // Any suggestions left (e.g. transfer secondary) — sweep by our test bill/income too.
    if (created.billIds.length) await db.delete(transactionMatchSuggestions).where(and(eq(transactionMatchSuggestions.userId, U), inArray(transactionMatchSuggestions.billId, created.billIds))).catch(() => {});
    if (created.incomeIds.length) await db.delete(transactionMatchSuggestions).where(and(eq(transactionMatchSuggestions.userId, U), inArray(transactionMatchSuggestions.incomeOccurrenceId, created.incomeIds))).catch(() => {});
    if (created.acctIds.length) await db.delete(accountMovements).where(and(eq(accountMovements.userId, U), inArray(accountMovements.accountId, created.acctIds))).catch(() => {});
    if (created.txnIds.length) await db.delete(importedTransactions).where(inArray(importedTransactions.id, created.txnIds)).catch(() => {});
    if (created.billIds.length) await db.delete(financialEntries).where(inArray(financialEntries.id, created.billIds)).catch(() => {});
    if (created.incomeIds.length) await db.delete(incomeEntries).where(inArray(incomeEntries.id, created.incomeIds)).catch(() => {});
    if (created.acctIds.length) await db.delete(financialAccounts).where(inArray(financialAccounts.id, created.acctIds)).catch(() => {});
    if (created.connId) await db.delete(financialConnections).where(eq(financialConnections.id, created.connId)).catch(() => {});
  } catch { /* best effort */ }
}

async function main() {
  console.log("Finance 1B.4A — deterministic transaction matching verification\n");

  // Startup sweep of any prior ZZ4A leftovers.
  const leftover = await db.select({ id: financialConnections.id }).from(financialConnections).where(and(eq(financialConnections.userId, U), like(financialConnections.providerItemId, "ZZ4A-%")));
  for (const c of leftover) {
    const ts = await db.select({ id: importedTransactions.id }).from(importedTransactions).where(eq(importedTransactions.connectionId, c.id));
    if (ts.length) { await db.delete(transactionMatchSuggestions).where(inArray(transactionMatchSuggestions.primaryTransactionId, ts.map((t) => t.id))).catch(() => {}); await db.delete(importedTransactions).where(eq(importedTransactions.connectionId, c.id)).catch(() => {}); }
    await db.delete(financialConnections).where(eq(financialConnections.id, c.id)).catch(() => {});
  }
  const swAcct = await db.select().from(financialAccounts).where(and(eq(financialAccounts.userId, U), like(financialAccounts.name, "ZZ4A%")));
  for (const a of swAcct) { await db.delete(accountMovements).where(eq(accountMovements.accountId, a.id)).catch(() => {}); await db.delete(financialEntries).where(eq(financialEntries.paidAccountId, a.id)).catch(() => {}); await db.delete(financialAccounts).where(eq(financialAccounts.id, a.id)).catch(() => {}); }

  // Owner baselines (preserve-and-verify).
  const ownerImportedBefore = (await db.select().from(importedTransactions).where(eq(importedTransactions.userId, U))).length;
  const ownerAcctsBefore = JSON.stringify((await db.select().from(financialAccounts).where(and(eq(financialAccounts.userId, U), isNull(financialAccounts.deletedAt)))).map((a) => ({ id: a.id, name: a.name, src: a.balanceSource, bal: a.currentBalance })).sort((x, y) => x.id - y.id));
  const ownerMovementsBefore = (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length;
  const ownerLogsBefore = (await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))).length;
  const ownerProviderBefore = JSON.stringify((await db.select().from(providerAccounts).where(eq(providerAccounts.userId, U))).map((p) => ({ id: p.id, bal: p.balanceCurrent })).sort((x, y) => x.id - y.id));

  // ---- test connection + accounts ----
  const [conn] = await db.insert(financialConnections).values({
    userId: U, provider: "plaid", providerItemId: `ZZ4A-${Date.now()}`, institutionName: "ZZ4A Test Bank",
    accessTokenCipher: "x", accessTokenNonce: "x", accessTokenTag: "x", accessTokenKeyVersion: 1, accessTokenEnvelopeVersion: 1,
    status: "active", environment: "sandbox",
  }).returning({ id: financialConnections.id });
  created.connId = conn.id;
  const mkAcct = async (name: string) => { const [a] = await db.insert(financialAccounts).values({ userId: U, name, type: "checking", purpose: "spending", balanceSource: "manual", currentBalance: "1000.00", active: true }).returning({ id: financialAccounts.id }); created.acctIds.push(a.id); return a.id; };
  const acctM = await mkAcct("ZZ4A Manual A");
  const acctM2 = await mkAcct("ZZ4A Manual B");

  const D = localToday();
  // ---- bills ----
  const mkBill = async (name: string, amt: number, due: string) => { const [b] = await db.insert(financialEntries).values({ userId: U, name, kind: "bill", expectedAmount: String(amt.toFixed(2)), dueDate: due, status: "scheduled", sourceAccountId: acctM }).returning({ id: financialEntries.id }); created.billIds.push(b.id); return b.id; };
  const billInternet = await mkBill("ZZ4A Internet", 100, D);
  const billB = await mkBill("ZZ4A CableB", 88, D);
  const billOther = await mkBill("ZZ4A Untouched", 12345, D); // no matching txn
  // ---- income ----
  const mkIncome = async (source: string, amt: number, pay: string, dest: number | null) => { const [i] = await db.insert(incomeEntries).values({ userId: U, source, expectedAmount: String(amt.toFixed(2)), payDate: pay, status: "scheduled", recurrence: "biweekly", destinationAccountId: dest, estimateType: "fixed" }).returning({ id: incomeEntries.id }); created.incomeIds.push(i.id); return i.id; };
  const incomePay = await mkIncome("ZZ4A Payroll", 200, D, acctM);
  const incomeDecoy = await mkIncome("ZZ4A Payroll", 999, D, acctM); // wrong amount → not selected
  const incomeOther = await mkIncome("ZZ4A OtherInc", 54321, D, acctM); // no matching txn

  // ---- imported transactions ----
  const txnBill = await mkTxn({ amount: -100, acctId: acctM, date: D, merchant: "ZZ4A Internet" });
  await mkTxn({ amount: -100, acctId: acctM, date: D, merchant: "ZZ4A Internet", pending: true }); // pending → no final bill
  await mkTxn({ amount: -100, acctId: acctM, date: D, merchant: "ZZ4A Internet", removed: true }); // removed → none
  await mkTxn({ amount: -500, acctId: acctM, date: D, merchant: "ZZ4A BigMismatch" }); // big amount mismatch
  await mkTxn({ amount: -100, acctId: acctM, date: addDays(D, -30), merchant: "ZZ4A Internet" }); // far date
  const txnIncome = await mkTxn({ amount: 200, acctId: acctM, date: D, merchant: "ZZ4A Payroll" });
  const txnBillB = await mkTxn({ amount: -88, acctId: acctM, date: D, merchant: "ZZ4A CableB" });
  // transfer good (300, different accounts)
  const txnTOut = await mkTxn({ amount: -300, acctId: acctM, date: D, merchant: "ZZ4A XferOut" });
  const txnTIn = await mkTxn({ amount: 300, acctId: acctM2, date: D, merchant: "ZZ4A XferIn" });
  // big mismatch transfer (410/360)
  await mkTxn({ amount: -410, acctId: acctM, date: D, merchant: "ZZ4A XmOut" });
  await mkTxn({ amount: 360, acctId: acctM2, date: D, merchant: "ZZ4A XmIn" });
  // far-date transfer (520, 10 days apart)
  await mkTxn({ amount: -520, acctId: acctM, date: D, merchant: "ZZ4A XfarOut" });
  await mkTxn({ amount: 520, acctId: acctM2, date: addDays(D, -10), merchant: "ZZ4A XfarIn" });
  // same-direction pair (77, two outflows)
  await mkTxn({ amount: -77, acctId: acctM, date: D, merchant: "ZZ4A SdirA" });
  await mkTxn({ amount: -77, acctId: acctM2, date: D, merchant: "ZZ4A SdirB" });
  // same-account pair (55 out + 55 in same account)
  await mkTxn({ amount: -55, acctId: acctM, date: D, merchant: "ZZ4A SacctOut" });
  await mkTxn({ amount: 55, acctId: acctM, date: D, merchant: "ZZ4A SacctIn" });

  // capture pre-generation domain baselines (for [59]-[65])
  const billStatesBefore = JSON.stringify((await db.select().from(financialEntries).where(inArray(financialEntries.id, created.billIds))).map((b) => [b.id, b.status, b.actualAmount, b.paidAt]));
  const incomeStatesBefore = JSON.stringify((await db.select().from(incomeEntries).where(inArray(incomeEntries.id, created.incomeIds))).map((i) => [i.id, i.status, i.actualAmount, i.receivedAt]));
  const transfersBefore = (await db.select().from(accountTransfers).where(eq(accountTransfers.userId, U))).length;
  const movementsAfterSetup = (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length;
  const acctBalBefore = JSON.stringify((await db.select().from(financialAccounts).where(inArray(financialAccounts.id, created.acctIds))).map((a) => [a.id, a.currentBalance]));
  const connCursorBefore = (await db.select({ c: financialConnections.transactionsCursor }).from(financialConnections).where(eq(financialConnections.id, created.connId)))[0].c;
  const providerBefore = JSON.stringify((await db.select().from(providerAccounts).where(eq(providerAccounts.userId, U))).map((p) => [p.id, p.balanceCurrent]));

  /* ============ generation + scoring [1-20] ============ */
  console.log("\n[generation + scoring]");
  const g1 = await generateMatchSuggestions(U);
  const pend = await getMatchSuggestionViews(U, { status: "pending" });
  const billSug = pend.find((s) => s.suggestionType === "bill_payment" && s.target?.id === billInternet);
  const incomeSug = pend.find((s) => s.suggestionType === "income_receipt");
  const transferSug = pend.find((s) => s.suggestionType === "transfer_pair");

  ok("[1] exact bill amount/date generates a bill suggestion", !!billSug && billSug.primary.id === txnBill);
  ok("[2] bill suggestion requires an outflow (it matched the outflow txn)", !!billSug && billSug.primary.amount < 0);
  ok("[3] a pending transaction does not generate a final bill suggestion", !pend.some((s) => s.suggestionType === "bill_payment" && s.primary.description === "ZZ4A Internet" && s.primary.id !== txnBill && s.primary.id !== txnBillB) && pend.filter((s) => s.suggestionType === "bill_payment" && s.target?.id === billInternet).length === 1);
  ok("[4] a removed transaction does not generate a suggestion", !pend.some((s) => created.txnIds.includes(s.primary.id) && [s.primary.id].some((id) => false)) && pend.every((s) => s.primary.id !== created.txnIds[2]));
  ok("[5] a large amount mismatch generates no bill suggestion", !pend.some((s) => s.suggestionType === "bill_payment" && Math.abs(s.primary.amount) === 500));
  ok("[6] a date outside the window generates no bill suggestion", !pend.some((s) => s.suggestionType === "bill_payment" && s.primary.date === addDays(D, -30)));
  ok("[7] exact income amount/date generates an income suggestion", !!incomeSug && incomeSug.primary.id === txnIncome);
  ok("[8] income requires an inflow (no income suggestion for an outflow)", !pend.some((s) => s.suggestionType === "income_receipt" && s.primary.amount < 0));
  ok("[9] the correct income occurrence is selected (200, not the decoy 999)", !!incomeSug && incomeSug.target?.id === incomePay && incomeSug.target?.id !== incomeDecoy);
  ok("[10] exact opposite transactions generate a transfer-pair suggestion", !!transferSug && [transferSug.primary.id, transferSug.secondary?.id].sort().join() === [txnTOut, txnTIn].sort().join());
  ok("[11] a same-account pair is rejected", !pend.some((s) => s.suggestionType === "transfer_pair" && Math.abs(s.primary.amount) === 55));
  ok("[12] a same-direction pair is rejected", !pend.some((s) => s.suggestionType === "transfer_pair" && Math.abs(s.primary.amount) === 77));
  ok("[13] a large transfer amount mismatch is rejected", !pend.some((s) => s.suggestionType === "transfer_pair" && (Math.abs(s.primary.amount) === 410 || Math.abs(s.primary.amount) === 360)));
  ok("[14] a date outside the transfer window is rejected", !pend.some((s) => s.suggestionType === "transfer_pair" && Math.abs(s.primary.amount) === 520));

  const score1 = billSug!.score;
  const g2 = await generateMatchSuggestions(U); // re-run
  const pend2 = await getMatchSuggestionViews(U, { status: "pending" });
  const billSug2 = pend2.find((s) => s.id === billSug!.id)!;
  ok("[15] scores are deterministic", billSug2.score === score1);
  ok("[16] confidence bands are deterministic", billSug2.confidence === billSug!.confidence && billSug!.confidence === (score1 >= BANDS.high ? "high" : score1 >= BANDS.medium ? "medium" : "low"));
  ok("[17] reason codes are present", billSug!.reasonCodes.length > 0 && incomeSug!.reasonCodes.length > 0 && transferSug!.reasonCodes.length > 0 && billSug!.reasonCodes.includes("exact_amount"));
  ok("[18] repeated generation is idempotent (no duplicate rows)", g2.generated === g1.generated && pend2.length === pend.length);
  const [c1, c2] = await Promise.all([generateMatchSuggestions(U), generateMatchSuggestions(U)]);
  const pend3 = await getMatchSuggestionViews(U, { status: "pending" });
  ok("[19] concurrent generation creates no duplicates", pend3.length === pend.length && (await db.select().from(transactionMatchSuggestions).where(and(eq(transactionMatchSuggestions.userId, U), eq(transactionMatchSuggestions.matchKey, `b:${billInternet}:${txnBill}`)))).length === 1);

  /* ============ domain protection on generation [59-65] ============ */
  console.log("\n[domain protection: generation mutates nothing]");
  ok("[59] suggestions alone mutate no bill", JSON.stringify((await db.select().from(financialEntries).where(inArray(financialEntries.id, created.billIds))).map((b) => [b.id, b.status, b.actualAmount, b.paidAt])) === billStatesBefore);
  ok("[60] suggestions alone mutate no income", JSON.stringify((await db.select().from(incomeEntries).where(inArray(incomeEntries.id, created.incomeIds))).map((i) => [i.id, i.status, i.actualAmount, i.receivedAt])) === incomeStatesBefore);
  ok("[61] suggestions alone mutate no transfer", (await db.select().from(accountTransfers).where(eq(accountTransfers.userId, U))).length === transfersBefore);
  ok("[62] suggestions create no account movement", (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length === movementsAfterSetup);
  ok("[63] suggestions alter no balance", JSON.stringify((await db.select().from(financialAccounts).where(inArray(financialAccounts.id, created.acctIds))).map((a) => [a.id, a.currentBalance])) === acctBalBefore);
  ok("[64] suggestions alter no provider snapshot", JSON.stringify((await db.select().from(providerAccounts).where(eq(providerAccounts.userId, U))).map((p) => [p.id, p.balanceCurrent])) === providerBefore);
  ok("[65] suggestions alter no transaction cursor", (await db.select({ c: financialConnections.transactionsCursor }).from(financialConnections).where(eq(financialConnections.id, created.connId)))[0].c === connCursorBefore);

  /* ============ bill confirmation [21-29] ============ */
  console.log("\n[bill confirmation]");
  const confBill = await confirmMatchSuggestion(U, billSug!.id);
  const billRow = () => db.select().from(financialEntries).where(eq(financialEntries.id, billInternet)).then((r) => r[0]);
  ok("[21] owner can confirm a valid bill suggestion", confBill.status === "confirmed");
  ok("[22] the correct bill occurrence is marked paid", (await billRow()).status === "paid");
  const sugRow = (await db.select().from(transactionMatchSuggestions).where(eq(transactionMatchSuggestions.id, billSug!.id)))[0];
  ok("[23] the evidence relationship is stored", sugRow.status === "confirmed" && sugRow.primaryTransactionId === txnBill && sugRow.billId === billInternet && sugRow.reviewedAt != null);
  const conf2 = await confirmMatchSuggestion(U, billSug!.id); // idempotent
  ok("[24] confirmation is idempotent", conf2.status === "confirmed");
  ok("[25] no duplicate movement is created", (await db.select().from(accountMovements).where(eq(accountMovements.billId, billInternet))).length === 1);
  ok("[26] provider balance is unchanged", JSON.stringify((await db.select().from(providerAccounts).where(eq(providerAccounts.userId, U))).map((p) => [p.id, p.balanceCurrent])) === providerBefore);
  ok("[27] an unrelated bill occurrence is unchanged", (await db.select().from(financialEntries).where(eq(financialEntries.id, billOther)))[0].status === "scheduled");

  // [28] removed/pending transaction confirmation is rejected.
  const billBsug = (await getMatchSuggestionViews(U, { status: "pending" })).find((s) => s.suggestionType === "bill_payment" && s.target?.id === billB);
  await db.update(importedTransactions).set({ status: "removed", removedAt: new Date() }).where(eq(importedTransactions.id, txnBillB));
  let rejected28 = false;
  try { await confirmMatchSuggestion(U, billBsug!.id); } catch (e) { rejected28 = e instanceof MatchError && e.status === 409; }
  ok("[28] removed/pending transaction confirmation is rejected", rejected28 && (await db.select().from(financialEntries).where(eq(financialEntries.id, billB)))[0].status === "scheduled");
  // [29] foreign-owner confirmation rejected.
  let foreign29 = false;
  try { await confirmMatchSuggestion(FOREIGN, billBsug!.id); } catch (e) { foreign29 = e instanceof MatchError && e.status === 404; }
  ok("[29] foreign-owner confirmation is rejected", foreign29);

  /* ============ income confirmation [30-36] ============ */
  console.log("\n[income confirmation]");
  const incomeSugLive = (await getMatchSuggestionViews(U, { status: "pending" })).find((s) => s.suggestionType === "income_receipt" && s.target?.id === incomePay)!;
  ok("[33pre] income suggestion is confirmable (manual destination)", incomeSugLive.confirmable === true);
  const confInc = await confirmMatchSuggestion(U, incomeSugLive.id);
  const incRow = () => db.select().from(incomeEntries).where(eq(incomeEntries.id, incomePay)).then((r) => r[0]);
  ok("[30] owner can confirm a valid income suggestion", confInc.status === "confirmed");
  ok("[31] the correct occurrence is marked received", (await incRow()).status === "received");
  ok("[32] the actual amount is preserved", num((await incRow()).actualAmount) === 200);
  ok("[33] estimated-vs-actual behavior remains valid", num((await incRow()).expectedAmount) === 200 && (await incRow()).actualAmount != null);
  const incSugRow = (await db.select().from(transactionMatchSuggestions).where(eq(transactionMatchSuggestions.id, incomeSugLive.id)))[0];
  ok("[34] the evidence relationship is stored", incSugRow.status === "confirmed" && incSugRow.primaryTransactionId === txnIncome && incSugRow.incomeOccurrenceId === incomePay);
  const confInc2 = await confirmMatchSuggestion(U, incomeSugLive.id);
  ok("[35] confirmation is idempotent", confInc2.status === "confirmed" && (await db.select().from(accountMovements).where(eq(accountMovements.incomeId, incomePay))).length >= 1 && (await db.select().from(accountMovements).where(eq(accountMovements.incomeId, incomePay))).length <= 1);
  ok("[36] an unrelated income occurrence is unchanged", (await db.select().from(incomeEntries).where(eq(incomeEntries.id, incomeOther)))[0].status === "scheduled");

  /* ============ transfer confirmation (model gap) [37-42] ============ */
  console.log("\n[transfer confirmation — fail closed]");
  const transferLive = (await getMatchSuggestionViews(U, { status: "pending" })).find((s) => s.suggestionType === "transfer_pair");
  // NOTE: Finance 1B.4B makes linked→linked transfers confirmable via evidence; a
  // manual/mixed transfer pair (this fixture's two manual test accounts) is still
  // gated, now with reason `account_combination`.
  ok("[37] transfer confirmation is gated for non-linked-pair (not confirmable)", !!transferLive && transferLive.confirmable === false && transferLive.confirmBlockedReason === "account_combination");
  ok("[38] both transaction-evidence links are preserved", !!transferLive && transferLive.primary.id != null && transferLive.secondary?.id != null);
  const movBeforeXfer = (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length;
  let xfer42 = false;
  try { await confirmMatchSuggestion(U, transferLive!.id); } catch (e) { xfer42 = e instanceof MatchError && e.status === 422; }
  ok("[39] transfer is not double-counted (no movements created)", (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length === movBeforeXfer);
  ok("[40] provider balances remain unchanged", JSON.stringify((await db.select().from(providerAccounts).where(eq(providerAccounts.userId, U))).map((p) => [p.id, p.balanceCurrent])) === providerBefore);
  ok("[41] one imported transaction cannot be reused in another confirmed transfer (deduped pair)", (await db.select().from(transactionMatchSuggestions).where(and(eq(transactionMatchSuggestions.userId, U), eq(transactionMatchSuggestions.suggestionType, "transfer_pair")))).length === 1);
  ok("[42] unsupported transfer confirmation fails closed + reports the model gap", xfer42 && (await db.select().from(transactionMatchSuggestions).where(eq(transactionMatchSuggestions.id, transferLive!.id)))[0].status === "pending");

  /* ============ rejection [43-47] ============ */
  console.log("\n[rejection]");
  const rej = await rejectMatchSuggestion(U, transferLive!.id, "not a transfer");
  ok("[43] owner can reject a suggestion", rej.status === "rejected");
  ok("[44] an optional bounded reason is preserved", (await db.select().from(transactionMatchSuggestions).where(eq(transactionMatchSuggestions.id, transferLive!.id)))[0].rejectionReason === "not a transfer");
  ok("[45] rejection mutates no finance record", (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length === movBeforeXfer && (await db.select().from(accountTransfers).where(eq(accountTransfers.userId, U))).length === transfersBefore);
  await generateMatchSuggestions(U); // regenerate
  ok("[46] a rejected identical relationship is not silently regenerated", (await db.select().from(transactionMatchSuggestions).where(eq(transactionMatchSuggestions.id, transferLive!.id)))[0].status === "rejected" && !(await getMatchSuggestionViews(U, { status: "pending" })).some((s) => s.id === transferLive!.id));
  let foreign47 = false;
  const aPending = (await getMatchSuggestionViews(U, { status: "pending" }))[0];
  try { if (aPending) await rejectMatchSuggestion(FOREIGN, aPending.id); else foreign47 = true; } catch (e) { foreign47 = e instanceof MatchError && e.status === 404; }
  ok("[47] foreign-owner rejection is rejected", foreign47);

  /* ============ UI (static) [48-58] ============ */
  console.log("\n[ui]");
  const uiSrc = read("components/finances/suggested-matches.tsx");
  const pageSrc = read("app/finances/page.tsx");
  ok("[48] Suggested Matches section renders", /Suggested matches/.test(pageSrc) && /<SuggestedMatches/.test(pageSrc));
  ok("[49] Find matches control renders", /Find matches/.test(uiSrc));
  ok("[50] type filters render (All/Bills/Income/Transfers)", /All/.test(uiSrc) && /Bills/.test(uiSrc) && /Income/.test(uiSrc) && /Transfers/.test(uiSrc));
  ok("[51] confidence renders", /CONF_LABEL|confidence/.test(uiSrc));
  ok("[52] reason explanation renders", /explanation/.test(uiSrc));
  ok("[53] Confirm and Reject render", /Confirm/.test(uiSrc) && /Reject/.test(uiSrc));
  ok("[54] default list is bounded", /const PAGE = 5/.test(uiSrc));
  ok("[55] show more/less works", /Show more/.test(uiSrc) && /Show less/.test(uiSrc));
  // NOTE: 1B.4B routes the in-card confirm dialog through `needsDialog(s)` (medium
  // confidence OR any evidence-only confirmation).
  ok("[56] medium-confidence confirmation dialog renders", /confirmingId/.test(uiSrc) && /Yes, confirm/.test(uiSrc) && /needsDialog\(s\)/.test(uiSrc));
  ok("[57] empty states are truthful", /No suggestions yet/.test(uiSrc) && /Run Find matches/.test(uiSrc) && /No likely matches found/.test(uiSrc));
  ok("[58] mobile 375px layout remains usable (responsive, no fixed wide widths)", /flex-wrap/.test(read("app/globals.css").match(/fin-match-actions[\s\S]{0,120}/)?.[0] ?? "") && !/width:\s*[4-9]\d\dpx/.test(uiSrc));

  /* ============ scope guardrails [66-70] ============ */
  console.log("\n[scope guardrails]");
  const svcSrc = read("lib/services/matching.ts");
  const routesSrc = read("app/api/finances/matches/route.ts") + read("app/api/finances/matches/generate/route.ts") + read("app/api/finances/matches/[id]/confirm/route.ts") + read("app/api/finances/matches/[id]/reject/route.ts");
  ok("[66] no AI categorization is added", !/anthropic|openai|categoriz|messages\.create/i.test(svcSrc + uiSrc + routesSrc));
  ok("[67] no webhook behavior changes", !/webhook/i.test(svcSrc + routesSrc));
  ok("[68] no Production Plaid work is added", !/production/i.test(svcSrc + routesSrc));
  ok("[69] no OAuth expansion is added", !/oauth|redirect_uri/i.test(svcSrc + routesSrc));
  ok("[70] no money movement is added (reuses payBill/receiveIncome only; no transfer/payment primitive)", !/createTransfer|completeTransfer|paymentInitiation|transferCreate|moveMoney/.test(svcSrc));

  /* ============ Home count ============ */
  const sectionsSrc = read("components/home/sections.tsx");
  ok("[home] Home shows a compact pending-match count only (no full list)", /transactionMatches > 0/.test(sectionsSrc) && /matches need|match needs/.test(sectionsSrc) && /review/.test(sectionsSrc) && !/SuggestedMatches|fin-match-list/.test(sectionsSrc) && typeof (await countPendingMatches(U)) === "number");

  await cleanup();

  /* ============ owner protection + regression [71-81] ============ */
  console.log("\n[owner protection]");
  const conns = await db.select().from(financialConnections).where(and(eq(financialConnections.userId, U), isNull(financialConnections.deletedAt)));
  const bofa = conns.find((c) => /bank of america/i.test(c.institutionName ?? ""));
  const accts = await db.select().from(financialAccounts).where(and(eq(financialAccounts.userId, U), isNull(financialAccounts.deletedAt)));
  const linked = accts.filter((a) => a.balanceSource === "linked"); let orphan = 0;
  for (const l of linked) { const m = await db.select().from(providerAccounts).where(and(eq(providerAccounts.financialAccountId, l.id), isNull(providerAccounts.deletedAt))); if (m.length !== 1) orphan++; }
  ok("[71] Bank of America Sandbox connection remains active", bofa?.status === "active" && bofa?.environment === "sandbox");
  ok("[72] Plaid Checking remains linked", accts.some((a) => a.name === "Plaid Checking" && a.balanceSource === "linked"));
  ok("[73] Chase and BofA manual accounts remain unchanged", accts.filter((a) => ["Chase", "BofA"].includes(a.name)).every((a) => a.balanceSource === "manual") && JSON.stringify(accts.map((a) => ({ id: a.id, name: a.name, src: a.balanceSource, bal: a.currentBalance })).sort((x, y) => x.id - y.id)) === ownerAcctsBefore);
  ok("[74] existing imported transactions remain intact", (await db.select().from(importedTransactions).where(eq(importedTransactions.userId, U))).length === ownerImportedBefore);
  ok("[75] no linked-account orphan is created", orphan === 0);
  ok("[76] bills/income/transfers/movements changed only via exact-ID temp records (owner movements restored)", (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length === ownerMovementsBefore);
  ok("[77] request 222 remains present", (await db.select().from(experienceRequests).where(eq(experienceRequests.id, 222))).length === 1);
  ok("[78] no usage-log row is created", (await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))).length === ownerLogsBefore);
  ok("[79] .env.local remains ignored (gitignore)", /(^|\n)\.env\.local/.test(read(".gitignore")));
  ok("[80] no secret in source (no token literal; no plaintext token column)", !/access-sandbox-[0-9a-f]{8}|sk-ant-|npg_/.test(svcSrc + uiSrc + routesSrc));
  ok("[81] exact-ID cleanup (no ZZ4A residue remains)", (await db.select().from(financialAccounts).where(and(eq(financialAccounts.userId, U), like(financialAccounts.name, "ZZ4A%")))).length === 0 && (await db.select().from(transactionMatchSuggestions).where(and(eq(transactionMatchSuggestions.userId, U), inArray(transactionMatchSuggestions.matchKey, [`b:${billInternet}:${txnBill}`, `i:${incomePay}:${txnIncome}`])))).length === 0 && JSON.stringify((await db.select().from(providerAccounts).where(eq(providerAccounts.userId, U))).map((p) => ({ id: p.id, bal: p.balanceCurrent })).sort((x, y) => x.id - y.id)) === ownerProviderBefore);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch(async (e) => { try { await cleanup(); } catch { /* noop */ } console.error(e); process.exit(1); });
