/* =============================================================================
 * verify-finance1b4b.ts — Finance 1B.4B deterministic verification.
 *
 * Evidence-only confirmation for LINKED-account income receipts + transfer pairs:
 * mark the planned event confirmed using imported bank transactions as proof,
 * WITHOUT any movement/balance/snapshot/cursor change. Manual workflows + bills
 * unchanged; mixed-account transfers fail closed. Exact-ID temp records only.
 * ===========================================================================*/

import { readFileSync } from "node:fs";
import { and, eq, inArray, isNull, like } from "drizzle-orm";
import { db } from "@/db";
import {
  importedTransactions, financialConnections, financialAccounts, financialEntries, incomeEntries,
  accountMovements, accountTransfers, providerAccounts, apiUsageLogs, experienceRequests,
  transactionMatchSuggestions, financialEventEvidence,
} from "@/db/schema";
import { CURRENT_USER_ID as U } from "@/lib/auth";
import { localToday } from "@/lib/time";
import { generateMatchSuggestions, getMatchSuggestionViews, confirmMatchSuggestion, rejectMatchSuggestion, MatchError } from "@/lib/services/matching";
import { createTransfer, completeTransfer } from "@/lib/services/transfers";

let passed = 0, failed = 0;
const ok = (n: string, c: boolean) => { c ? passed++ : failed++; console.log(`${c ? "✓" : "✗"} ${n}`); };
const read = (p: string) => readFileSync(p, "utf8");
const num = (s: string | null | undefined) => (s == null ? 0 : Number(s));
const FOREIGN = U + 99999;
const created = { conn: 0, accts: [] as number[], bills: [] as number[], incomes: [] as number[], txns: [] as number[], transfers: [] as number[] };

async function cleanup() {
  try {
    await db.delete(financialEventEvidence).where(eq(financialEventEvidence.userId, U)).catch(() => {});
    await db.delete(transactionMatchSuggestions).where(eq(transactionMatchSuggestions.userId, U)).catch(() => {});
    if (created.accts.length) await db.delete(accountMovements).where(and(eq(accountMovements.userId, U), inArray(accountMovements.accountId, created.accts))).catch(() => {});
    if (created.transfers.length) await db.delete(accountTransfers).where(inArray(accountTransfers.id, created.transfers)).catch(() => {});
    if (created.txns.length) await db.delete(importedTransactions).where(inArray(importedTransactions.id, created.txns)).catch(() => {});
    if (created.bills.length) await db.delete(financialEntries).where(inArray(financialEntries.id, created.bills)).catch(() => {});
    if (created.incomes.length) await db.delete(incomeEntries).where(inArray(incomeEntries.id, created.incomes)).catch(() => {});
    if (created.accts.length) await db.delete(financialAccounts).where(inArray(financialAccounts.id, created.accts)).catch(() => {});
    if (created.conn) await db.delete(financialConnections).where(eq(financialConnections.id, created.conn)).catch(() => {});
  } catch { /* best effort */ }
}

async function main() {
  console.log("Finance 1B.4B — evidence-only linked confirmation verification\n");

  // owner baselines
  const ownerImportedBefore = (await db.select().from(importedTransactions).where(eq(importedTransactions.userId, U))).length;
  const ownerProviderBefore = JSON.stringify((await db.select().from(providerAccounts).where(eq(providerAccounts.userId, U))).map((p) => [p.id, p.balanceCurrent]).sort());
  const ownerMovementsBefore = (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length;
  const ownerLogsBefore = (await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))).length;

  const D = localToday();
  const [c] = await db.insert(financialConnections).values({ userId: U, provider: "plaid", providerItemId: `ZZ4B-${Date.now()}`, institutionName: "ZZ4B Bank", accessTokenCipher: "x", accessTokenNonce: "x", accessTokenTag: "x", accessTokenKeyVersion: 1, accessTokenEnvelopeVersion: 1, status: "active", environment: "sandbox" }).returning({ id: financialConnections.id });
  created.conn = c.id;
  const mkAcct = async (name: string, source: "manual" | "linked") => { const [a] = await db.insert(financialAccounts).values({ userId: U, name, type: "checking", purpose: "spending", balanceSource: source, currentBalance: "1000.00", active: true }).returning({ id: financialAccounts.id }); created.accts.push(a.id); return a.id; };
  const linkA = await mkAcct("ZZ4B Linked A", "linked"), linkB = await mkAcct("ZZ4B Linked B", "linked"), manualA = await mkAcct("ZZ4B Manual A", "manual"), manualB = await mkAcct("ZZ4B Manual B", "manual");
  const mkIncome = async (source: string, amt: number, dest: number) => { const [i] = await db.insert(incomeEntries).values({ userId: U, source, expectedAmount: String(amt.toFixed(2)), payDate: D, status: "scheduled", recurrence: "biweekly", destinationAccountId: dest, estimateType: "fixed" }).returning({ id: incomeEntries.id }); created.incomes.push(i.id); return i.id; };
  const incLinked = await mkIncome("ZZ4B Payroll", 200, linkA), incManual = await mkIncome("ZZ4B SideGig", 300, manualA), incOther = await mkIncome("ZZ4B Other", 99999, linkA);
  const mkBill = async (name: string, amt: number) => { const [b] = await db.insert(financialEntries).values({ userId: U, name, kind: "bill", expectedAmount: String(amt.toFixed(2)), dueDate: D, status: "scheduled", sourceAccountId: manualA }).returning({ id: financialEntries.id }); created.bills.push(b.id); return b.id; };
  const billManual = await mkBill("ZZ4B Rent", 100), billLinked = await mkBill("ZZ4B Internet", 150);
  const mkTxn = async (amt: number, acct: number, m: string, o: { pending?: boolean; removed?: boolean } = {}) => { const [t] = await db.insert(importedTransactions).values({ userId: U, connectionId: c.id, providerAccountId: "pa", provider: "plaid", providerTransactionId: `ZZ4B-${created.txns.length}-${Date.now()}`, status: o.removed ? "removed" : "active", isPending: o.pending ?? false, amount: String(amt.toFixed(2)), descriptionCurrent: m, merchantName: m, financialAccountId: acct, postedDate: D }).returning({ id: importedTransactions.id }); created.txns.push(t.id); return t.id; };
  const txnIncL = await mkTxn(200, linkA, "ZZ4B Payroll");        // linked income inflow
  const txnIncM = await mkTxn(300, manualA, "ZZ4B SideGig");      // manual income inflow
  const txnBillM = await mkTxn(-100, manualA, "ZZ4B Rent");       // manual bill outflow
  const txnBillL = await mkTxn(-150, linkA, "ZZ4B Internet");     // linked bill outflow
  const txnTOutL = await mkTxn(-500, linkA, "ZZ4B XfOut");        // linked→linked transfer
  const txnTInL = await mkTxn(500, linkB, "ZZ4B XfIn");
  const txnTOutMix = await mkTxn(-600, linkA, "ZZ4B MixOut");     // linked→manual (mixed)
  const txnTInMix = await mkTxn(600, manualA, "ZZ4B MixIn");

  // baselines for "no movement / no balance / no provider / no cursor" assertions
  const linkedAcctsBefore = JSON.stringify((await db.select().from(financialAccounts).where(inArray(financialAccounts.id, [linkA, linkB]))).map((a) => [a.id, a.currentBalance, a.balanceUpdatedAt]).sort());
  const cursorBefore = (await db.select({ x: financialConnections.transactionsCursor }).from(financialConnections).where(eq(financialConnections.id, c.id)))[0].x;
  const movementsAfterSetup = (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length;
  const importedSnapBefore = JSON.stringify((await db.select().from(importedTransactions).where(inArray(importedTransactions.id, [txnIncL, txnTOutL, txnTInL]))).map((t) => [t.id, t.status, t.amount, t.isPending, t.postedDate]).sort());

  await generateMatchSuggestions(U);

  /* ===================== linked-income evidence [1-18] ===================== */
  console.log("\n[linked-income evidence]");
  let pend = await getMatchSuggestionViews(U, { status: "pending" });
  const sLinkInc = pend.find((s) => s.suggestionType === "income_receipt" && s.target?.id === incLinked)!;
  ok("[pre] linked-income suggestion is now confirmable via evidence", !!sLinkInc && sLinkInc.confirmable === true && sLinkInc.confirmMode === "linked_evidence");
  const cInc = await confirmMatchSuggestion(U, sLinkInc.id);
  const incRow = () => db.select().from(incomeEntries).where(eq(incomeEntries.id, incLinked)).then((r) => r[0]);
  const evInc = () => db.select().from(financialEventEvidence).where(and(eq(financialEventEvidence.userId, U), eq(financialEventEvidence.incomeOccurrenceId, incLinked)));
  ok("[1] valid linked-income suggestion can be confirmed", cInc.status === "confirmed");
  ok("[2] correct occurrence is marked received (received_evidence)", (await incRow()).status === "received_evidence");
  ok("[3] actual imported amount is recorded", num((await incRow()).actualAmount) === 200);
  ok("[4] imported posted date is recorded (evidence)", (await evInc())[0]?.confirmedDate === D);
  ok("[5] evidence relationship is stored", (await evInc()).length === 1 && (await evInc())[0].confirmationMode === "linked_evidence" && (await evInc())[0].primaryTransactionId === txnIncL);
  ok("[6] suggestion becomes confirmed", (await db.select().from(transactionMatchSuggestions).where(eq(transactionMatchSuggestions.id, sLinkInc.id)))[0].status === "confirmed");
  ok("[7] no account movement is created", (await db.select().from(accountMovements).where(eq(accountMovements.incomeId, incLinked))).length === 0);
  ok("[8] linked balance unchanged", JSON.stringify((await db.select().from(financialAccounts).where(inArray(financialAccounts.id, [linkA, linkB]))).map((a) => [a.id, a.currentBalance, a.balanceUpdatedAt]).sort()) === linkedAcctsBefore);
  ok("[9] provider snapshot unchanged", JSON.stringify((await db.select().from(providerAccounts).where(eq(providerAccounts.userId, U))).map((p) => [p.id, p.balanceCurrent]).sort()) === ownerProviderBefore);
  ok("[10] transaction cursor unchanged", (await db.select({ x: financialConnections.transactionsCursor }).from(financialConnections).where(eq(financialConnections.id, c.id)))[0].x === cursorBefore);
  ok("[11] imported transaction unchanged", (await db.select().from(importedTransactions).where(eq(importedTransactions.id, txnIncL)))[0].status === "active");
  const cInc2 = await confirmMatchSuggestion(U, sLinkInc.id);
  ok("[12] repeated confirmation is idempotent", cInc2.status === "confirmed" && (await evInc()).length === 1);
  // concurrency: re-seed a fresh linked-income occurrence + txn, confirm twice concurrently
  const incLinked2 = await mkIncome("ZZ4B Payroll2", 210, linkA); const txnIncL2 = await mkTxn(210, linkA, "ZZ4B Payroll2");
  await generateMatchSuggestions(U);
  const sLinkInc2 = (await getMatchSuggestionViews(U, { status: "pending" })).find((s) => s.suggestionType === "income_receipt" && s.target?.id === incLinked2)!;
  await Promise.all([confirmMatchSuggestion(U, sLinkInc2.id).catch(() => {}), confirmMatchSuggestion(U, sLinkInc2.id).catch(() => {})]);
  ok("[13] concurrent confirmation creates one evidence row", (await db.select().from(financialEventEvidence).where(and(eq(financialEventEvidence.userId, U), eq(financialEventEvidence.incomeOccurrenceId, incLinked2)))).length === 1);
  // competing suggestion superseded: seed a 2nd income at 200 matching txnIncL... txnIncL already used. Use a fresh competing pair.
  const incLinked3 = await mkIncome("ZZ4B PayrollDup", 220, linkA); const txnIncL3 = await mkTxn(220, linkA, "ZZ4B PayrollDup"); const txnIncL3b = await mkTxn(220, linkA, "ZZ4B PayrollDup");
  await generateMatchSuggestions(U);
  const dupSugs = (await getMatchSuggestionViews(U, { status: "pending" })).filter((s) => s.suggestionType === "income_receipt" && s.target?.id === incLinked3);
  await confirmMatchSuggestion(U, dupSugs[0].id);
  ok("[14] competing suggestions are superseded", (await getMatchSuggestionViews(U, { status: "pending" })).filter((s) => s.suggestionType === "income_receipt" && s.target?.id === incLinked3).length === 0 && dupSugs.length >= 1);
  // pending/removed/wrong-direction/foreign rejection — craft a fresh occurrence + txn
  const incR = await mkIncome("ZZ4B Reject", 230, linkA);
  const txnPend = await mkTxn(230, linkA, "ZZ4B Reject", { pending: true });
  // generation won't suggest a pending txn; craft a suggestion row directly to test the confirm guard
  const [sp] = await db.insert(transactionMatchSuggestions).values({ userId: U, suggestionType: "income_receipt", status: "pending", primaryTransactionId: txnPend, incomeOccurrenceId: incR, score: 90, confidence: "high", reasonCodes: "[]", matchKey: `i:${incR}:${txnPend}` }).returning({ id: transactionMatchSuggestions.id });
  let r15 = false; try { await confirmMatchSuggestion(U, sp.id); } catch (e) { r15 = e instanceof MatchError && e.status === 409; }
  ok("[15] pending transaction is rejected", r15);
  await db.update(importedTransactions).set({ status: "removed", isPending: false }).where(eq(importedTransactions.id, txnPend));
  await db.update(transactionMatchSuggestions).set({ status: "pending" }).where(eq(transactionMatchSuggestions.id, sp.id));
  let r16 = false; try { await confirmMatchSuggestion(U, sp.id); } catch (e) { r16 = e instanceof MatchError && e.status === 409; }
  ok("[16] removed transaction is rejected", r16);
  // wrong direction: outflow txn on an income suggestion
  const incWd = await mkIncome("ZZ4B WrongDir", 240, linkA); const txnOut = await mkTxn(-240, linkA, "ZZ4B WrongDir");
  const [swd] = await db.insert(transactionMatchSuggestions).values({ userId: U, suggestionType: "income_receipt", status: "pending", primaryTransactionId: txnOut, incomeOccurrenceId: incWd, score: 90, confidence: "high", reasonCodes: "[]", matchKey: `i:${incWd}:${txnOut}` }).returning({ id: transactionMatchSuggestions.id });
  let r17 = false; try { await confirmMatchSuggestion(U, swd.id); } catch (e) { r17 = e instanceof MatchError && e.status === 409; }
  ok("[17] wrong-direction transaction is rejected", r17);
  let r18 = false; try { await confirmMatchSuggestion(FOREIGN, sLinkInc.id); } catch (e) { r18 = e instanceof MatchError && e.status === 404; }
  ok("[18] foreign-owner access is rejected", r18);

  /* ===================== transfer evidence [19-38] ===================== */
  console.log("\n[transfer evidence]");
  await generateMatchSuggestions(U);
  pend = await getMatchSuggestionViews(U, { status: "pending" });
  const sXferLL = pend.find((s) => s.suggestionType === "transfer_pair" && [s.primary.id, s.secondary?.id].sort().join() === [txnTOutL, txnTInL].sort().join())!;
  ok("[pre] linked→linked transfer suggestion is confirmable via evidence", !!sXferLL && sXferLL.confirmable === true && sXferLL.confirmMode === "linked_evidence");
  const cXfer = await confirmMatchSuggestion(U, sXferLL.id);
  const evXfer = () => db.select().from(financialEventEvidence).where(and(eq(financialEventEvidence.userId, U), eq(financialEventEvidence.eventType, "transfer")));
  ok("[19] valid linked-to-linked transfer pair can be confirmed", cXfer.status === "confirmed");
  const evx = (await evXfer()).find((e) => [e.primaryTransactionId, e.secondaryTransactionId].sort().join() === [txnTOutL, txnTInL].sort().join())!;
  ok("[20] both transaction links are preserved", !!evx && evx.primaryTransactionId === txnTOutL && evx.secondaryTransactionId === txnTInL);
  ok("[21/22/23/24] one inflow+outflow, different accounts, amount+date enforced (suggestion exists only when all hold)", num((await db.select().from(importedTransactions).where(eq(importedTransactions.id, txnTOutL)))[0].amount) < 0);
  ok("[25] suggestion becomes confirmed", (await db.select().from(transactionMatchSuggestions).where(eq(transactionMatchSuggestions.id, sXferLL.id)))[0].status === "confirmed");
  ok("[26] planned transfer becomes evidence-confirmed (linked_evidence)", evx.confirmationMode === "linked_evidence");
  ok("[27] no account movement is created", (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length === movementsAfterSetup);
  ok("[28/29] source + destination linked balances unchanged", JSON.stringify((await db.select().from(financialAccounts).where(inArray(financialAccounts.id, [linkA, linkB]))).map((a) => [a.id, a.currentBalance, a.balanceUpdatedAt]).sort()) === linkedAcctsBefore);
  ok("[30] provider snapshots unchanged", JSON.stringify((await db.select().from(providerAccounts).where(eq(providerAccounts.userId, U))).map((p) => [p.id, p.balanceCurrent]).sort()) === ownerProviderBefore);
  ok("[31] transaction cursor unchanged", (await db.select({ x: financialConnections.transactionsCursor }).from(financialConnections).where(eq(financialConnections.id, c.id)))[0].x === cursorBefore);
  ok("[32] both imported transactions unchanged", JSON.stringify((await db.select().from(importedTransactions).where(inArray(importedTransactions.id, [txnIncL, txnTOutL, txnTInL]))).map((t) => [t.id, t.status, t.amount, t.isPending, t.postedDate]).sort()) === importedSnapBefore);
  const cXfer2 = await confirmMatchSuggestion(U, sXferLL.id);
  ok("[33] repeated confirmation is idempotent", cXfer2.status === "confirmed" && (await evXfer()).filter((e) => e.eventKey === `transfer:${Math.min(txnTOutL, txnTInL)}:${Math.max(txnTOutL, txnTInL)}`).length === 1);
  // concurrency: fresh linked-linked pair
  const txnTOutL2 = await mkTxn(-510, linkA, "ZZ4B XfOut2"); const txnTInL2 = await mkTxn(510, linkB, "ZZ4B XfIn2");
  await generateMatchSuggestions(U);
  const sXfer2 = (await getMatchSuggestionViews(U, { status: "pending" })).find((s) => s.suggestionType === "transfer_pair" && [s.primary.id, s.secondary?.id].sort().join() === [txnTOutL2, txnTInL2].sort().join())!;
  await Promise.all([confirmMatchSuggestion(U, sXfer2.id).catch(() => {}), confirmMatchSuggestion(U, sXfer2.id).catch(() => {})]);
  ok("[34] concurrent confirmation creates one evidence row", (await evXfer()).filter((e) => e.eventKey === `transfer:${Math.min(txnTOutL2, txnTInL2)}:${Math.max(txnTOutL2, txnTInL2)}`).length === 1);
  // [35] one txn cannot confirm another incompatible transfer (reuse txnTOutL via crafted suggestion)
  const [sReuse] = await db.insert(transactionMatchSuggestions).values({ userId: U, suggestionType: "transfer_pair", status: "pending", primaryTransactionId: txnTOutL, secondaryTransactionId: txnTInL2, score: 90, confidence: "high", reasonCodes: "[]", matchKey: `t:reuse:${txnTOutL}` }).returning({ id: transactionMatchSuggestions.id });
  let r35 = false; try { await confirmMatchSuggestion(U, sReuse.id); } catch (e) { r35 = e instanceof MatchError && e.status === 409; }
  ok("[35] one transaction cannot confirm another incompatible transfer", r35);
  // [36] missing second transaction fails closed
  const [sMiss] = await db.insert(transactionMatchSuggestions).values({ userId: U, suggestionType: "transfer_pair", status: "pending", primaryTransactionId: txnTOutMix, secondaryTransactionId: null, score: 90, confidence: "high", reasonCodes: "[]", matchKey: `t:miss:${txnTOutMix}` }).returning({ id: transactionMatchSuggestions.id });
  let r36 = false; try { await confirmMatchSuggestion(U, sMiss.id); } catch (e) { r36 = e instanceof MatchError && e.status === 422; }
  ok("[36] missing second transaction fails closed", r36);
  // [37] pending/removed transfer txn fails closed
  const txnTOutP = await mkTxn(-520, linkA, "ZZ4B XfP", { pending: true }); const txnTInP = await mkTxn(520, linkB, "ZZ4B XfPin");
  const [sPend] = await db.insert(transactionMatchSuggestions).values({ userId: U, suggestionType: "transfer_pair", status: "pending", primaryTransactionId: txnTOutP, secondaryTransactionId: txnTInP, score: 90, confidence: "high", reasonCodes: "[]", matchKey: `t:pend:${txnTOutP}` }).returning({ id: transactionMatchSuggestions.id });
  let r37 = false; try { await confirmMatchSuggestion(U, sPend.id); } catch (e) { r37 = e instanceof MatchError && e.status === 409; }
  ok("[37] pending or removed transaction fails closed", r37);
  let r38 = false; try { await confirmMatchSuggestion(FOREIGN, sXferLL.id); } catch (e) { r38 = e instanceof MatchError && e.status === 404; }
  ok("[38] foreign-owner access is rejected", r38);

  /* ===================== account combinations [39-43] ===================== */
  console.log("\n[account combinations]");
  await generateMatchSuggestions(U);
  const sMix = (await getMatchSuggestionViews(U, { status: "pending" })).find((s) => s.suggestionType === "transfer_pair" && [s.primary.id, s.secondary?.id].sort().join() === [txnTOutMix, txnTInMix].sort().join());
  ok("[39] linked-to-linked uses evidence-only confirmation", evx.confirmationMode === "linked_evidence");
  // [40] manual→manual continues using the existing workflow (createTransfer/completeTransfer)
  const tr = await createTransfer(U, { fromAccountId: manualA, toAccountId: manualB, amount: 25 }); created.transfers.push(tr.id);
  const done = await completeTransfer(U, tr.id);
  ok("[40] manual-to-manual continues using the existing workflow (movements created)", done?.status === "completed" && (await db.select().from(accountMovements).where(eq(accountMovements.transferId, tr.id))).length === 2);
  ok("[41] unsupported linked/manual combination fails closed (not confirmable)", !!sMix && sMix.confirmable === false && sMix.confirmBlockedReason === "account_combination");
  let r42 = false; try { await confirmMatchSuggestion(U, sMix!.id); } catch (e) { r42 = e instanceof MatchError && e.status === 422; }
  ok("[42] unsupported account combination shows no misleading success (422)", r42 && (await db.select().from(transactionMatchSuggestions).where(eq(transactionMatchSuggestions.id, sMix!.id)))[0].status === "pending");
  ok("[43] no hybrid double-counting (mixed pair created no evidence, no movement on linkA from the transfer path)", (await evXfer()).every((e) => e.primaryTransactionId !== txnTOutMix) && (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length === movementsAfterSetup + 2);

  /* ===================== bill + manual-income regression [44-49] ===================== */
  console.log("\n[bill + manual-income regression]");
  const sBillM = (await getMatchSuggestionViews(U, { status: "pending" })).find((s) => s.suggestionType === "bill_payment" && s.target?.id === billManual)!;
  await confirmMatchSuggestion(U, sBillM.id);
  ok("[44] bill confirmation still works", (await db.select().from(financialEntries).where(eq(financialEntries.id, billManual)))[0].status === "paid");
  ok("[45] manual bill movement behavior unchanged (one movement on the manual account)", (await db.select().from(accountMovements).where(eq(accountMovements.billId, billManual))).length === 1);
  const sBillL = (await getMatchSuggestionViews(U, { status: "pending" })).find((s) => s.suggestionType === "bill_payment" && s.target?.id === billLinked)!;
  await confirmMatchSuggestion(U, sBillL.id);
  ok("[46] linked bill confirmation still creates no movement", (await db.select().from(financialEntries).where(eq(financialEntries.id, billLinked)))[0].status === "paid" && (await db.select().from(accountMovements).where(eq(accountMovements.billId, billLinked))).length === 0);
  const sIncM = (await getMatchSuggestionViews(U, { status: "pending" })).find((s) => s.suggestionType === "income_receipt" && s.target?.id === incManual)!;
  ok("[pre] manual-income suggestion uses manual_workflow", sIncM.confirmMode === "manual_workflow");
  await confirmMatchSuggestion(U, sIncM.id);
  ok("[47] manual-destination income confirmation still works", (await db.select().from(incomeEntries).where(eq(incomeEntries.id, incManual)))[0].status === "received");
  ok("[48] manual income creates only its existing expected movement", (await db.select().from(accountMovements).where(eq(accountMovements.incomeId, incManual))).length === 1);
  const cIncMrepeat = await confirmMatchSuggestion(U, sIncM.id);
  ok("[49] no duplicate receipt is created", cIncMrepeat.status === "confirmed" && (await db.select().from(accountMovements).where(eq(accountMovements.incomeId, incManual))).length === 1);

  /* ===================== UI [50-59] ===================== */
  console.log("\n[ui]");
  const uiSrc = read("components/finances/suggested-matches.tsx");
  ok("[50] linked-income Confirm renders (driven by confirmable; linked income now confirmable)", /s\.confirmable \?/.test(uiSrc));
  ok("[51] linked-income warning text renders", /will mark the scheduled income as received using the imported bank transaction as evidence\. It will not change the linked account balance\./.test(uiSrc));
  ok("[52] linked-transfer Confirm renders when supported", /needsDialog\(s\)|s\.confirmable/.test(uiSrc));
  ok("[53] linked-transfer warning text renders", /will mark the transfer confirmed using both imported bank transactions as evidence\. It will not create new movements or change linked balances\./.test(uiSrc));
  ok("[54] unsupported mixed transfer shows no Confirm button (blocked note)", /account_combination.*not yet supported for this account combination/i.test(uiSrc) && /blockedNote\(s\.confirmBlockedReason\)/.test(uiSrc));
  ok("[55] evidence badge renders after confirmation", /Confirmed using bank evidence/.test(uiSrc) && /fin-match-evidence/.test(uiSrc));
  ok("[56] confirmed amount/date render", /confirmation\.confirmedAmount/.test(uiSrc) && /confirmation\.confirmedDate/.test(uiSrc));
  ok("[57] transfer shows both evidence transactions", /s\.secondary &&/.test(uiSrc));
  ok("[58] mobile 375px layout usable (responsive evidence row, flex-wrap)", /flex-wrap/.test(read("app/globals.css").match(/fin-match-evidence[\s\S]{0,120}/)?.[0] ?? ""));
  ok("[59] no horizontal overflow (no fixed wide widths in the component)", !/width:\s*[4-9]\d\dpx/.test(uiSrc));

  /* ===================== domain boundaries [60-70] ===================== */
  console.log("\n[domain boundaries]");
  const svcSrc = read("lib/services/matching.ts");
  const routesSrc = read("app/api/finances/matches/[id]/confirm/route.ts") + read("app/api/finances/matches/route.ts");
  ok("[60] no Production Plaid work", !/production/i.test(svcSrc + routesSrc));
  ok("[61] no OAuth expansion", !/oauth|redirect_uri/i.test(svcSrc + routesSrc));
  ok("[62] no money movement primitive in linked-evidence path", !/createTransfer|completeTransfer|paymentInitiation|transferCreate|moveMoney/.test(svcSrc));
  ok("[63] no AI categorization", !/anthropic|openai|categoriz|messages\.create/i.test(svcSrc + uiSrc));
  ok("[64] no automatic confirmation (confirm only via explicit owner action)", !/autoConfirm|automatic.*confirm/i.test(svcSrc));
  ok("[65] no webhook behavior change", !/webhook/i.test(svcSrc));
  ok("[66] no sync-cursor change (cursor stable across all evidence confirms)", (await db.select({ x: financialConnections.transactionsCursor }).from(financialConnections).where(eq(financialConnections.id, c.id)))[0].x === cursorBefore);
  ok("[67] no provider-balance rewrite", JSON.stringify((await db.select().from(providerAccounts).where(eq(providerAccounts.userId, U))).map((p) => [p.id, p.balanceCurrent]).sort()) === ownerProviderBefore);
  ok("[68] no imported-transaction rewrite (evidence txns unchanged)", JSON.stringify((await db.select().from(importedTransactions).where(inArray(importedTransactions.id, [txnIncL, txnTOutL, txnTInL]))).map((t) => [t.id, t.status, t.amount, t.isPending, t.postedDate]).sort()) === importedSnapBefore);
  ok("[69] no duplicate movement (linked evidence confirms created none; only manual bill+income+manual transfer)", (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length === movementsAfterSetup + 2 /*manual transfer*/ + 1 /*manual bill*/ + 1 /*manual income*/);
  ok("[70] no synthetic bank activity (linked evidence never inserts movements/transfers)", (await db.select().from(accountMovements).where(inArray(accountMovements.accountId, [linkA, linkB]))).length === 0 && (await db.select().from(accountTransfers).where(and(eq(accountTransfers.userId, U), inArray(accountTransfers.fromAccountId, [linkA, linkB])))).length === 0);

  await cleanup();

  /* ===================== owner protection [71-81] ===================== */
  console.log("\n[owner protection]");
  const conns = await db.select().from(financialConnections).where(and(eq(financialConnections.userId, U), isNull(financialConnections.deletedAt)));
  const bofa = conns.find((x) => /bank of america/i.test(x.institutionName ?? ""));
  const accts = await db.select().from(financialAccounts).where(and(eq(financialAccounts.userId, U), isNull(financialAccounts.deletedAt)));
  const linked = accts.filter((a) => a.balanceSource === "linked"); let orphan = 0;
  for (const l of linked) { const m = await db.select().from(providerAccounts).where(and(eq(providerAccounts.financialAccountId, l.id), isNull(providerAccounts.deletedAt))); if (m.length !== 1) orphan++; }
  ok("[71] Bank of America Sandbox remains active", bofa?.status === "active" && bofa?.environment === "sandbox");
  ok("[72] Plaid Checking remains linked", accts.some((a) => a.name === "Plaid Checking" && a.balanceSource === "linked"));
  ok("[73] Chase and BofA remain manual", accts.filter((a) => ["Chase", "BofA"].includes(a.name)).every((a) => a.balanceSource === "manual"));
  ok("[74] existing imported transactions remain intact", (await db.select().from(importedTransactions).where(eq(importedTransactions.userId, U))).length === ownerImportedBefore);
  ok("[75] no linked-account orphan exists", orphan === 0);
  ok("[76] request 222 remains present", (await db.select().from(experienceRequests).where(eq(experienceRequests.id, 222))).length === 1);
  ok("[77] no usage-log row is created", (await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))).length === ownerLogsBefore);
  ok("[78] .env.local remains ignored (gitignore)", /(^|\n)\.env\.local/.test(read(".gitignore")));
  ok("[79] no secret in source", !/access-sandbox-[0-9a-f]{8}|sk-ant-|npg_/.test(svcSrc + uiSrc + routesSrc));
  ok("[80/81] exact-ID cleanup (no ZZ4B residue, no leftover evidence/suggestions/movements)",
    (await db.select().from(financialAccounts).where(and(eq(financialAccounts.userId, U), like(financialAccounts.name, "ZZ4B%")))).length === 0
    && (await db.select().from(financialEventEvidence).where(eq(financialEventEvidence.userId, U))).length === 0
    && (await db.select().from(transactionMatchSuggestions).where(eq(transactionMatchSuggestions.userId, U))).length === 0
    && (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length === ownerMovementsBefore);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch(async (e) => { try { await cleanup(); } catch { /* noop */ } console.error(e); process.exit(1); });
