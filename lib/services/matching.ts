/* =============================================================================
 * Xanther — Finance 1B.4A: deterministic transaction-matching SUGGESTIONS.
 *
 * Imported bank transactions are EVIDENCE; Xanther finance records are the
 * owner's plans/confirmed actions. This service SUGGESTS relationships between
 * them with a bounded, explainable score — it NEVER mutates either side. Only an
 * explicit owner confirmation applies an effect, and only through the existing
 * approved workflows (payBill / receiveIncome). Transfer pairs and linked-account
 * income are a documented model gap: their suggestions are generated + shown but
 * confirmation fails closed (never invents new financial behavior, never
 * double-counts a provider-authoritative balance). No AI, no money movement,
 * Sandbox-scoped (operates only on the owner's imported transactions).
 * ===========================================================================*/

// Server-only (DB + reuse of balance-mutating workflows).
if (typeof window !== "undefined") {
  throw new Error("matching service is server-only and must not be imported in the browser.");
}

import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import {
  importedTransactions,
  financialEntries,
  incomeEntries,
  incomeAllocations,
  financialAccounts,
  transactionMatchSuggestions,
} from "@/db/schema";
import { localToday } from "@/lib/time";
import { payBill, receiveIncome, FinanceError } from "./finances";

export class MatchError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "MatchError";
    this.status = status;
  }
}

/* ---------------------------------------------------------- tolerances --- */
// Documented, bounded tolerances + date windows (America/New_York date-only
// comparisons — see calendarDayDiff; never raw UTC instants that could shift the
// owner-visible day).
export const TOLERANCES = {
  bill: { absUsd: 1.0, pct: 0.02, windowDays: 7 },
  income: { absUsd: 1.0, pct: 0.05, windowDays: 5 },
  transfer: { absUsd: 0.01, windowDays: 3 }, // transfers must match (only provider-rounding slack)
} as const;
export const MIN_SCORE = 50; // suggestions below this are never persisted or shown
export const BANDS = { high: 80, medium: 60 } as const; // high ≥80, medium 60–79, low 50–59

const num = (s: string | null | undefined): number => (s == null ? 0 : Number(s));
const round = (n: number): number => Math.round(n);

/** Calendar-day distance between two YYYY-MM-DD date-only strings (tz-safe). */
export function calendarDayDiff(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const pa = a.slice(0, 10).split("-").map(Number);
  const pb = b.slice(0, 10).split("-").map(Number);
  if (pa.length !== 3 || pb.length !== 3 || pa.some(isNaN) || pb.some(isNaN)) return null;
  const ua = Date.UTC(pa[0], pa[1] - 1, pa[2]);
  const ub = Date.UTC(pb[0], pb[1] - 1, pb[2]);
  return Math.abs(Math.round((ua - ub) / 86400000));
}

const STOP = new Set(["the", "and", "for", "inc", "llc", "co", "payment", "bill", "deposit", "monthly", "auto"]);
function tokens(s: string | null | undefined): string[] {
  if (!s) return [];
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((t) => t.length >= 3 && !STOP.has(t));
}
/** Deterministic 0..1 name similarity: fraction of `name` tokens present in the
 * transaction text (merchant + description). */
function nameSimilarity(name: string | null | undefined, ...texts: (string | null | undefined)[]): number {
  const nt = tokens(name);
  if (!nt.length) return 0;
  const hay = new Set(texts.flatMap(tokens));
  if (!hay.size) return 0;
  const hit = nt.filter((t) => hay.has(t)).length;
  return hit / nt.length;
}

function band(score: number): "high" | "medium" | "low" {
  if (score >= BANDS.high) return "high";
  if (score >= BANDS.medium) return "medium";
  return "low";
}

/* ----------------------------------------------------------- scoring --- */
interface Scored { score: number; reasonCodes: string[]; }

function scoreBill(txnAmt: number, txnDate: string | null, txnMerchant: string | null, txnDesc: string | null, billAmt: number, billName: string, billDue: string | null): (Scored & { amountDifference: number; dateDifferenceDays: number | null }) | null {
  if (!(txnAmt < 0)) return null; // must be an outflow
  const out = Math.abs(txnAmt);
  const amountDifference = round((out - billAmt) * 100) / 100;
  const absDiff = Math.abs(amountDifference);
  const tol = Math.max(TOLERANCES.bill.absUsd, billAmt * TOLERANCES.bill.pct);
  if (absDiff > tol) return null; // large mismatch never matches
  const dd = calendarDayDiff(txnDate, billDue);
  if (dd == null || dd > TOLERANCES.bill.windowDays) return null; // outside the window
  const reasonCodes: string[] = [];
  let score = 0;
  if (absDiff < 0.005) { score += 50; reasonCodes.push("exact_amount"); }
  else { score += 30; reasonCodes.push("amount_within_tolerance"); }
  score += round(30 - (dd / TOLERANCES.bill.windowDays) * 15); reasonCodes.push("date_within_window");
  const sim = nameSimilarity(billName, txnMerchant, txnDesc);
  if (sim > 0) { score += round(sim * 15); reasonCodes.push("merchant_name_match"); }
  score += 5; reasonCodes.push("posted_transaction");
  return { score: Math.min(100, score), reasonCodes, amountDifference, dateDifferenceDays: dd };
}

function scoreIncome(txnAmt: number, txnDate: string | null, txnMerchant: string | null, txnDesc: string | null, expected: number, min: number | null, max: number | null, source: string, payDate: string | null): (Scored & { amountDifference: number; dateDifferenceDays: number | null }) | null {
  if (!(txnAmt > 0)) return null; // must be an inflow
  const amountDifference = round((txnAmt - expected) * 100) / 100;
  const absDiff = Math.abs(amountDifference);
  const inRange = min != null && max != null && txnAmt >= min - 0.005 && txnAmt <= max + 0.005;
  const tol = Math.max(TOLERANCES.income.absUsd, expected * TOLERANCES.income.pct);
  if (!inRange && absDiff > tol) return null;
  const dd = calendarDayDiff(txnDate, payDate);
  if (dd == null || dd > TOLERANCES.income.windowDays) return null;
  const reasonCodes: string[] = [];
  let score = 0;
  if (absDiff < 0.005) { score += 50; reasonCodes.push("exact_amount"); }
  else { score += inRange ? 45 : 30; reasonCodes.push("amount_within_tolerance"); }
  score += round(30 - (dd / TOLERANCES.income.windowDays) * 15); reasonCodes.push("date_within_window");
  const sim = nameSimilarity(source, txnMerchant, txnDesc);
  if (sim > 0) { score += round(sim * 15); reasonCodes.push("income_source_match"); }
  score += 5; reasonCodes.push("posted_transaction");
  return { score: Math.min(100, score), reasonCodes, amountDifference, dateDifferenceDays: dd };
}

function scoreTransfer(outAmt: number, outDate: string | null, outAcct: number, inAmt: number, inDate: string | null, inAcct: number): (Scored & { amountDifference: number; dateDifferenceDays: number | null }) | null {
  if (!(outAmt < 0) || !(inAmt > 0)) return null; // one outflow + one inflow
  if (outAcct === inAcct) return null; // must be different accounts
  const amountDifference = round((Math.abs(outAmt) - inAmt) * 100) / 100;
  if (Math.abs(amountDifference) > TOLERANCES.transfer.absUsd) return null; // transfers must match
  const dd = calendarDayDiff(outDate, inDate);
  if (dd == null || dd > TOLERANCES.transfer.windowDays) return null;
  const reasonCodes: string[] = ["exact_amount", "opposite_transfer_direction", "different_owner_accounts", "date_within_window", "posted_transaction"];
  let score = 40 + 20 + 20 + 5;
  score += round(15 - (dd / TOLERANCES.transfer.windowDays) * 8);
  return { score: Math.min(100, score), reasonCodes, amountDifference, dateDifferenceDays: dd };
}

/* -------------------------------------------------- suggestion generation --- */
const BILL_ELIGIBLE = ["scheduled", "due", "overdue"];

export interface GenerateResult { generated: number; pending: number; superseded: number; byType: { bill_payment: number; income_receipt: number; transfer_pair: number }; }

/**
 * Deterministically (re)generate suggestions for the owner. Idempotent: upserts
 * by (userId, matchKey); a `pending` row is refreshed, while confirmed/rejected/
 * superseded decisions are preserved and NEVER reopened. Suggestions referencing
 * a removed transaction or an ineligible record are superseded. Mutates NO bill,
 * income, transfer, balance, movement, snapshot, or transaction cursor.
 */
export async function generateMatchSuggestions(userId: number): Promise<GenerateResult> {
  const txns = await db.select().from(importedTransactions).where(and(eq(importedTransactions.userId, userId), isNull(importedTransactions.deletedAt)));
  const active = txns.filter((t) => t.status === "active" && !t.isPending); // posted + active only
  const bills = await db.select().from(financialEntries).where(and(eq(financialEntries.userId, userId), isNull(financialEntries.deletedAt), eq(financialEntries.kind, "bill")));
  const eligibleBills = bills.filter((b) => BILL_ELIGIBLE.includes(b.status) && b.dueDate);
  const incomes = await db.select().from(incomeEntries).where(and(eq(incomeEntries.userId, userId), isNull(incomeEntries.deletedAt), eq(incomeEntries.status, "scheduled")));
  const eligibleIncome = incomes.filter((i) => i.payDate);

  type Cand = {
    suggestionType: "bill_payment" | "income_receipt" | "transfer_pair";
    primaryTransactionId: number; secondaryTransactionId: number | null;
    billId: number | null; incomeOccurrenceId: number | null;
    score: number; confidence: "high" | "medium" | "low"; reasonCodes: string[];
    amountDifference: number | null; dateDifferenceDays: number | null; matchKey: string;
  };
  const cands: Cand[] = [];

  // Bills
  for (const t of active) {
    if (num(t.amount) >= 0) continue;
    for (const b of eligibleBills) {
      const s = scoreBill(num(t.amount), t.postedDate, t.merchantName, t.descriptionCurrent, num(b.expectedAmount), b.name, b.dueDate);
      if (!s || s.score < MIN_SCORE) continue;
      cands.push({ suggestionType: "bill_payment", primaryTransactionId: t.id, secondaryTransactionId: null, billId: b.id, incomeOccurrenceId: null, score: s.score, confidence: band(s.score), reasonCodes: s.reasonCodes, amountDifference: s.amountDifference, dateDifferenceDays: s.dateDifferenceDays, matchKey: `b:${b.id}:${t.id}` });
    }
  }
  // Income
  for (const t of active) {
    if (num(t.amount) <= 0) continue;
    for (const o of eligibleIncome) {
      const s = scoreIncome(num(t.amount), t.postedDate, t.merchantName, t.descriptionCurrent, num(o.expectedAmount), o.expectedMin != null ? num(o.expectedMin) : null, o.expectedMax != null ? num(o.expectedMax) : null, o.source, o.payDate);
      if (!s || s.score < MIN_SCORE) continue;
      cands.push({ suggestionType: "income_receipt", primaryTransactionId: t.id, secondaryTransactionId: null, billId: null, incomeOccurrenceId: o.id, score: s.score, confidence: band(s.score), reasonCodes: s.reasonCodes, amountDifference: s.amountDifference, dateDifferenceDays: s.dateDifferenceDays, matchKey: `i:${o.id}:${t.id}` });
    }
  }
  // Transfer pairs (each unordered pair at most once)
  for (let i = 0; i < active.length; i++) {
    for (let j = 0; j < active.length; j++) {
      if (i === j) continue;
      const out = active[i], inc = active[j];
      if (num(out.amount) >= 0 || num(inc.amount) <= 0) continue;
      if (out.financialAccountId == null || inc.financialAccountId == null) continue;
      const s = scoreTransfer(num(out.amount), out.postedDate, out.financialAccountId, num(inc.amount), inc.postedDate, inc.financialAccountId);
      if (!s || s.score < MIN_SCORE) continue;
      const lo = Math.min(out.id, inc.id), hi = Math.max(out.id, inc.id);
      const key = `t:${lo}:${hi}`;
      if (cands.some((c) => c.matchKey === key)) continue; // dedup unordered pair
      cands.push({ suggestionType: "transfer_pair", primaryTransactionId: out.id, secondaryTransactionId: inc.id, billId: null, incomeOccurrenceId: null, score: s.score, confidence: band(s.score), reasonCodes: s.reasonCodes, amountDifference: s.amountDifference, dateDifferenceDays: s.dateDifferenceDays, matchKey: key });
    }
  }

  // Upsert idempotently. Conflict on (userId, matchKey): refresh ONLY pending rows
  // (preserve confirmed/rejected/superseded decisions; never reopen). The unique
  // index also makes concurrent generation duplicate-free.
  const byType = { bill_payment: 0, income_receipt: 0, transfer_pair: 0 };
  for (const c of cands) {
    byType[c.suggestionType]++;
    await db
      .insert(transactionMatchSuggestions)
      .values({
        userId, suggestionType: c.suggestionType, status: "pending",
        primaryTransactionId: c.primaryTransactionId, secondaryTransactionId: c.secondaryTransactionId,
        billId: c.billId, incomeOccurrenceId: c.incomeOccurrenceId, transferId: null,
        score: c.score, confidence: c.confidence, reasonCodes: JSON.stringify(c.reasonCodes),
        amountDifference: c.amountDifference != null ? String(c.amountDifference) : null,
        dateDifferenceDays: c.dateDifferenceDays, matchKey: c.matchKey,
      })
      .onConflictDoUpdate({
        target: [transactionMatchSuggestions.userId, transactionMatchSuggestions.matchKey],
        set: { score: c.score, confidence: c.confidence, reasonCodes: JSON.stringify(c.reasonCodes), amountDifference: c.amountDifference != null ? String(c.amountDifference) : null, dateDifferenceDays: c.dateDifferenceDays, updatedAt: new Date() },
        setWhere: eq(transactionMatchSuggestions.status, "pending"),
      });
  }

  // Supersede pending suggestions that are no longer valid: their evidence
  // transaction was removed/deleted, or the bill/income is no longer eligible.
  const removedTxnIds = txns.filter((t) => t.status === "removed" || t.deletedAt != null).map((t) => t.id);
  const ineligibleBillIds = bills.filter((b) => !BILL_ELIGIBLE.includes(b.status) || b.deletedAt != null).map((b) => b.id);
  const ineligibleIncomeIds = incomes.filter((i) => i.status !== "scheduled" || i.deletedAt != null).map((i) => i.id);
  let superseded = 0;
  const supersede = async (where: ReturnType<typeof and>) => {
    const r = await db.update(transactionMatchSuggestions).set({ status: "superseded", updatedAt: new Date() }).where(where).returning({ id: transactionMatchSuggestions.id });
    superseded += r.length;
  };
  if (removedTxnIds.length) {
    await supersede(and(eq(transactionMatchSuggestions.userId, userId), eq(transactionMatchSuggestions.status, "pending"), inArray(transactionMatchSuggestions.primaryTransactionId, removedTxnIds)));
    await supersede(and(eq(transactionMatchSuggestions.userId, userId), eq(transactionMatchSuggestions.status, "pending"), inArray(transactionMatchSuggestions.secondaryTransactionId, removedTxnIds)));
  }
  if (ineligibleBillIds.length) await supersede(and(eq(transactionMatchSuggestions.userId, userId), eq(transactionMatchSuggestions.status, "pending"), inArray(transactionMatchSuggestions.billId, ineligibleBillIds)));
  if (ineligibleIncomeIds.length) await supersede(and(eq(transactionMatchSuggestions.userId, userId), eq(transactionMatchSuggestions.status, "pending"), inArray(transactionMatchSuggestions.incomeOccurrenceId, ineligibleIncomeIds)));

  const pending = (await db.select({ id: transactionMatchSuggestions.id }).from(transactionMatchSuggestions).where(and(eq(transactionMatchSuggestions.userId, userId), eq(transactionMatchSuggestions.status, "pending")))).length;
  return { generated: cands.length, pending, superseded, byType };
}

/* ------------------------------------------------------------- views --- */
export interface MatchSuggestionView {
  id: number; suggestionType: "bill_payment" | "income_receipt" | "transfer_pair"; status: string;
  score: number; confidence: "high" | "medium" | "low"; reasonCodes: string[]; explanation: string;
  primary: { id: number; amount: number; date: string | null; description: string; accountLabel: string };
  secondary: { id: number; amount: number; date: string | null; description: string; accountLabel: string } | null;
  target: { kind: "bill" | "income" | "transfer"; id: number | null; name: string; amount: number | null; date: string | null } | null;
  amountDifference: number | null; dateDifferenceDays: number | null;
  confirmable: boolean; confirmBlockedReason: string | null;
  createdAt: string; reviewedAt: string | null; rejectionReason: string | null;
}

function explain(type: string, reasons: string[], dd: number | null): string {
  const has = (c: string) => reasons.includes(c);
  if (type === "bill_payment") {
    const amt = has("exact_amount") ? "Exact amount" : "Amount within tolerance";
    const date = dd === 0 ? "on the due date" : dd != null ? `${dd} day${dd === 1 ? "" : "s"} from the due date` : "near the due date";
    return `${amt} ${date}${has("merchant_name_match") ? ", name matches" : ""}`;
  }
  if (type === "income_receipt") {
    const amt = has("exact_amount") ? "Deposit amount matches scheduled income" : "Deposit amount near scheduled income";
    return `${amt}${has("income_source_match") ? ", source matches" : ""}`;
  }
  return "Equal amounts moved between two accounts";
}

export async function getMatchSuggestionViews(userId: number, opts: { status?: string; type?: string } = {}): Promise<MatchSuggestionView[]> {
  const status = opts.status && ["pending", "confirmed", "rejected", "superseded"].includes(opts.status) ? opts.status : "pending";
  const where = [eq(transactionMatchSuggestions.userId, userId), eq(transactionMatchSuggestions.status, status as "pending")];
  if (opts.type && ["bill_payment", "income_receipt", "transfer_pair"].includes(opts.type)) where.push(eq(transactionMatchSuggestions.suggestionType, opts.type as "bill_payment"));
  const rows = await db.select().from(transactionMatchSuggestions).where(and(...where)).orderBy(transactionMatchSuggestions.score);
  rows.reverse(); // highest score first

  // Bounded lookups for labels + confirmability.
  const txnIds = [...new Set(rows.flatMap((r) => [r.primaryTransactionId, r.secondaryTransactionId].filter((x): x is number => x != null)))];
  const txnMap = new Map<number, typeof importedTransactions.$inferSelect>();
  if (txnIds.length) (await db.select().from(importedTransactions).where(inArray(importedTransactions.id, txnIds))).forEach((t) => txnMap.set(t.id, t));
  const billIds = [...new Set(rows.map((r) => r.billId).filter((x): x is number => x != null))];
  const billMap = new Map<number, typeof financialEntries.$inferSelect>();
  if (billIds.length) (await db.select().from(financialEntries).where(inArray(financialEntries.id, billIds))).forEach((b) => billMap.set(b.id, b));
  const incomeIds = [...new Set(rows.map((r) => r.incomeOccurrenceId).filter((x): x is number => x != null))];
  const incomeMap = new Map<number, typeof incomeEntries.$inferSelect>();
  if (incomeIds.length) (await db.select().from(incomeEntries).where(inArray(incomeEntries.id, incomeIds))).forEach((i) => incomeMap.set(i.id, i));
  // Account label + linked-state map.
  const accts = await db.select().from(financialAccounts).where(and(eq(financialAccounts.userId, userId), isNull(financialAccounts.deletedAt)));
  const acctName = new Map(accts.map((a) => [a.id, a.name]));
  const acctLinked = new Map(accts.map((a) => [a.id, a.balanceSource === "linked"]));
  // Income allocations (to detect a linked destination in a split).
  const allocs = incomeIds.length ? await db.select().from(incomeAllocations).where(and(eq(incomeAllocations.userId, userId), isNull(incomeAllocations.deletedAt), inArray(incomeAllocations.incomeId, incomeIds))) : [];
  const allocByIncome = new Map<number, number[]>();
  for (const a of allocs) { const arr = allocByIncome.get(a.incomeId) ?? []; arr.push(a.accountId); allocByIncome.set(a.incomeId, arr); }

  const txnView = (id: number | null) => {
    if (id == null) return null;
    const t = txnMap.get(id);
    if (!t) return null;
    return { id: t.id, amount: num(t.amount), date: t.postedDate, description: t.merchantName ?? t.descriptionCurrent, accountLabel: t.financialAccountId != null ? (acctName.get(t.financialAccountId) ?? "Linked account") : "Not added to Xanther" };
  };

  return rows.map((r) => {
    const reasons = JSON.parse(r.reasonCodes) as string[];
    let target: MatchSuggestionView["target"] = null;
    let confirmable = false; let confirmBlockedReason: string | null = null;
    if (r.suggestionType === "bill_payment") {
      const b = r.billId != null ? billMap.get(r.billId) : undefined;
      target = { kind: "bill", id: r.billId, name: b?.name ?? "Bill", amount: b ? num(b.expectedAmount) : null, date: b?.dueDate ?? null };
      confirmable = true; // payBill is safe (linked paid-account → mark paid, no balance change)
    } else if (r.suggestionType === "income_receipt") {
      const o = r.incomeOccurrenceId != null ? incomeMap.get(r.incomeOccurrenceId) : undefined;
      target = { kind: "income", id: r.incomeOccurrenceId, name: o?.source ?? "Income", amount: o ? num(o.expectedAmount) : null, date: o?.payDate ?? null };
      // Confirmable only if every destination is a manual account (receiveIncome
      // rejects linked destinations — provider-authoritative balance).
      const dests = (allocByIncome.get(r.incomeOccurrenceId ?? -1) ?? (o?.destinationAccountId != null ? [o.destinationAccountId] : []));
      if (!dests.length) { confirmable = false; confirmBlockedReason = "no_destination"; }
      else if (dests.some((d) => acctLinked.get(d))) { confirmable = false; confirmBlockedReason = "linked_account"; }
      else confirmable = true;
    } else {
      target = null; // transfer pair: both sides are imported transactions
      confirmable = false; confirmBlockedReason = "transfer_model_gap";
    }
    if (r.status !== "pending") { confirmable = false; }
    return {
      id: r.id, suggestionType: r.suggestionType, status: r.status,
      score: r.score, confidence: r.confidence, reasonCodes: reasons, explanation: explain(r.suggestionType, reasons, r.dateDifferenceDays),
      primary: txnView(r.primaryTransactionId)!, secondary: txnView(r.secondaryTransactionId),
      target, amountDifference: r.amountDifference != null ? num(r.amountDifference) : null, dateDifferenceDays: r.dateDifferenceDays,
      confirmable, confirmBlockedReason,
      createdAt: r.createdAt.toISOString(), reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null, rejectionReason: r.rejectionReason,
    };
  }).filter((v) => v.primary != null);
}

/** Compact count of pending suggestions (for Home). Nonsecret. */
export async function countPendingMatches(userId: number): Promise<number> {
  return (await db.select({ id: transactionMatchSuggestions.id }).from(transactionMatchSuggestions).where(and(eq(transactionMatchSuggestions.userId, userId), eq(transactionMatchSuggestions.status, "pending")))).length;
}

/* -------------------------------------------------- confirm / reject --- */
type PayBillFn = typeof payBill;
type ReceiveIncomeFn = typeof receiveIncome;

/**
 * Owner-confirm a suggestion. Ownership + eligibility are SERVER-derived (the
 * browser supplies only the suggestion id). We claim the suggestion atomically
 * (pending→confirmed), then apply the existing approved workflow; on failure we
 * REVERT the claim (compensating update — neon-http has no interactive
 * transactions) so the suggestion stays recoverably pending and no half-state
 * persists. Transfer pairs and linked-account income FAIL CLOSED (model gap).
 */
export async function confirmMatchSuggestion(userId: number, id: number, opts?: { payBillFn?: PayBillFn; receiveIncomeFn?: ReceiveIncomeFn }): Promise<MatchSuggestionView> {
  const _payBill = opts?.payBillFn ?? payBill;
  const _receiveIncome = opts?.receiveIncomeFn ?? receiveIncome;

  const [row] = await db.select().from(transactionMatchSuggestions).where(and(eq(transactionMatchSuggestions.id, id), eq(transactionMatchSuggestions.userId, userId)));
  if (!row) throw new MatchError(404, "Suggestion not found.");
  if (row.status === "confirmed") return (await getMatchSuggestionViews(userId, { status: "confirmed" })).find((v) => v.id === id) ?? (() => { throw new MatchError(409, "Already confirmed."); })();
  if (row.status !== "pending") throw new MatchError(409, "This suggestion can no longer be confirmed.");

  // Fail closed for unsupported confirmations (model gap) — never invent behavior.
  if (row.suggestionType === "transfer_pair") throw new MatchError(422, "Transfer confirmation is not yet supported (transfer model gap).");

  // Revalidate evidence is still active + posted.
  const prim = (await db.select().from(importedTransactions).where(eq(importedTransactions.id, row.primaryTransactionId)))[0];
  if (!prim || prim.status !== "active" || prim.deletedAt != null) throw new MatchError(409, "The matched transaction is no longer available.");
  if (prim.isPending) throw new MatchError(409, "A pending transaction cannot confirm a record.");

  // Atomic claim: pending → confirmed. Only the winner proceeds.
  const claim = await db.update(transactionMatchSuggestions).set({ status: "confirmed", reviewedAt: new Date(), updatedAt: new Date() }).where(and(eq(transactionMatchSuggestions.id, id), eq(transactionMatchSuggestions.userId, userId), eq(transactionMatchSuggestions.status, "pending"))).returning({ id: transactionMatchSuggestions.id });
  if (!claim.length) throw new MatchError(409, "This suggestion can no longer be confirmed.");

  try {
    if (row.suggestionType === "bill_payment") {
      const bill = (await db.select().from(financialEntries).where(and(eq(financialEntries.id, row.billId!), eq(financialEntries.userId, userId), isNull(financialEntries.deletedAt))))[0];
      if (!bill || !BILL_ELIGIBLE.includes(bill.status)) throw new MatchError(409, "The bill is no longer payable.");
      // Use the imported transaction's account as the paid-from account (linked →
      // payBill marks paid with NO balance change) and its posted amount as actual.
      const applied = await _payBill(userId, row.billId!, prim.financialAccountId ?? null, Math.abs(num(prim.amount)));
      if (!applied) throw new MatchError(409, "The bill could not be confirmed (already changed).");
    } else if (row.suggestionType === "income_receipt") {
      // receiveIncome fails closed (throws FinanceError) if any destination is linked.
      const applied = await _receiveIncome(userId, row.incomeOccurrenceId!, num(prim.amount), prim.postedDate ?? undefined);
      if (!applied) throw new MatchError(409, "The income could not be confirmed (already changed).");
    }
  } catch (e) {
    // Compensate: revert the claim so the suggestion stays pending + recoverable.
    await db.update(transactionMatchSuggestions).set({ status: "pending", reviewedAt: null, updatedAt: new Date() }).where(eq(transactionMatchSuggestions.id, id)).catch(() => {});
    if (e instanceof MatchError) throw e;
    if (e instanceof FinanceError) throw new MatchError(e.status === 400 ? 422 : e.status, e.message);
    throw new MatchError(500, "Could not confirm the suggestion.");
  }

  // Supersede competing pending suggestions that would reuse the same evidence
  // transaction or the same finance record (no incompatible double-confirm).
  const competeTxn = [row.primaryTransactionId, row.secondaryTransactionId].filter((x): x is number => x != null);
  await db.update(transactionMatchSuggestions).set({ status: "superseded", updatedAt: new Date() }).where(and(eq(transactionMatchSuggestions.userId, userId), eq(transactionMatchSuggestions.status, "pending"), ne(transactionMatchSuggestions.id, id), inArray(transactionMatchSuggestions.primaryTransactionId, competeTxn)));
  if (row.billId != null) await db.update(transactionMatchSuggestions).set({ status: "superseded", updatedAt: new Date() }).where(and(eq(transactionMatchSuggestions.userId, userId), eq(transactionMatchSuggestions.status, "pending"), ne(transactionMatchSuggestions.id, id), eq(transactionMatchSuggestions.billId, row.billId)));
  if (row.incomeOccurrenceId != null) await db.update(transactionMatchSuggestions).set({ status: "superseded", updatedAt: new Date() }).where(and(eq(transactionMatchSuggestions.userId, userId), eq(transactionMatchSuggestions.status, "pending"), ne(transactionMatchSuggestions.id, id), eq(transactionMatchSuggestions.incomeOccurrenceId, row.incomeOccurrenceId)));

  const view = (await getMatchSuggestionViews(userId, { status: "confirmed" })).find((v) => v.id === id);
  if (!view) throw new MatchError(500, "Confirmation succeeded but the view could not be loaded.");
  return view;
}

/** Owner-reject a suggestion. Mutates NO finance record. The rejected row is kept
 * for audit; an identical relationship is never silently regenerated (its row,
 * keyed by matchKey, retains `rejected`). */
export async function rejectMatchSuggestion(userId: number, id: number, reason?: string | null): Promise<MatchSuggestionView> {
  const [row] = await db.select({ id: transactionMatchSuggestions.id, status: transactionMatchSuggestions.status }).from(transactionMatchSuggestions).where(and(eq(transactionMatchSuggestions.id, id), eq(transactionMatchSuggestions.userId, userId)));
  if (!row) throw new MatchError(404, "Suggestion not found.");
  if (row.status === "rejected") { const v = (await getMatchSuggestionViews(userId, { status: "rejected" })).find((x) => x.id === id); if (v) return v; }
  if (row.status !== "pending") throw new MatchError(409, "Only a pending suggestion can be rejected.");
  const bounded = reason ? String(reason).slice(0, 300) : null;
  await db.update(transactionMatchSuggestions).set({ status: "rejected", reviewedAt: new Date(), rejectionReason: bounded, updatedAt: new Date() }).where(and(eq(transactionMatchSuggestions.id, id), eq(transactionMatchSuggestions.userId, userId), eq(transactionMatchSuggestions.status, "pending")));
  const view = (await getMatchSuggestionViews(userId, { status: "rejected" })).find((v) => v.id === id);
  if (!view) throw new MatchError(500, "Rejection succeeded but the view could not be loaded.");
  return view;
}
