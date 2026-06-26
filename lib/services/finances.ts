/* Finances service.
 *
 * Holds the real computeFinancialOutlook() the README calls for, plus CRUD for
 * the three underlying tables: accounts (balances), bills (financialEntries
 * with kind="bill"), and income (incomeEntries / paydays).
 *
 * The Neon HTTP driver returns numeric columns as strings, so every money value
 * is parsed with num() before arithmetic. */

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  financialAccounts,
  financialEntries,
  incomeEntries,
  incomeAllocations,
  accountMovements,
} from "@/db/schema";
import { localDaysUntil } from "@/lib/time";
import { resolveBalanceAuthority } from "@/lib/providers/balance-authority";

/* Finance 1B.2: minimal provider snapshot shape used to resolve a linked
 * account's authoritative balance (passed in from the provider-accounts service
 * to avoid a service-layer import cycle). */
export type LinkedSnapshot = {
  balanceCurrent: string | null;
  balanceAvailable: string | null;
  balanceAsOf: Date | null;
  status: string; // active | stale
  providerName: string;
  currencyCode: string | null;
};
import type {
  AccountView,
  AllocationView,
  BillView,
  CashSummary,
  IncomeView,
  MovementView,
  FinancialOutlook,
} from "@/lib/types";

export type NewAccount = typeof financialAccounts.$inferInsert;
export type NewBill = typeof financialEntries.$inferInsert;
export type NewIncome = typeof incomeEntries.$inferInsert;

/* Shared with the API routes (kept out of route.ts per Next.js export rules). */
export const BILL_STATUSES = ["scheduled", "due", "paid", "overdue", "skipped"] as const;

/* Finance 1A.1 controlled vocabularies. Stored as validated varchars (not
 * pgEnums) so the owner can extend them later without a type migration; the
 * service + routes reject anything outside these lists. */
export const ACCOUNT_TYPES = ["checking", "savings", "cash", "credit", "other"] as const;
export const ACCOUNT_PURPOSES = [
  "spending",
  "bills",
  "savings",
  "emergency",
  "cash",
  "other",
] as const;
export const BALANCE_SOURCES = ["manual", "linked"] as const;
// Finance 1A.4: recurring-income vocabularies (validated in the schedule service).
export const INCOME_CADENCES = ["one_time", "weekly", "biweekly", "semimonthly", "monthly"] as const;
export const ESTIMATE_TYPES = ["fixed", "typical", "range", "unknown"] as const;

// Account types whose (positive) balance is spendable cash. Credit is a
// liability and `other` is unclassified — neither counts as cash.
export const CASH_TYPES = new Set(["checking", "savings", "cash"]);
export const isCashType = (type: string) => CASH_TYPES.has(type);
export const isLiabilityType = (type: string) => type === "credit";

export const num = (v: string | null | undefined): number => (v ? parseFloat(v) : 0);
const todayIso = () => new Date().toISOString().slice(0, 10);
const addDays = (iso: string, n: number): string => {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

// Bills in these states are still owed.
const BILL_OPEN = new Set(["scheduled", "due", "overdue"]);

/* --------------------------------------------------------------- queries --- */

export async function listAccounts(userId: number) {
  return db
    .select()
    .from(financialAccounts)
    .where(and(eq(financialAccounts.userId, userId), isNull(financialAccounts.deletedAt)))
    .orderBy(asc(financialAccounts.name));
}

/** A single live account owned by this user, or null. */
export async function getAccount(userId: number, id: number) {
  const [row] = await db
    .select()
    .from(financialAccounts)
    .where(
      and(
        eq(financialAccounts.id, id),
        eq(financialAccounts.userId, userId),
        isNull(financialAccounts.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** True if the id is a live account owned by this user. Used to validate a
 * bill's source/paid account before linking (a null link is always allowed). */
export async function accountExists(userId: number, id: number): Promise<boolean> {
  const [row] = await db
    .select({ id: financialAccounts.id })
    .from(financialAccounts)
    .where(
      and(
        eq(financialAccounts.id, id),
        eq(financialAccounts.userId, userId),
        isNull(financialAccounts.deletedAt),
      ),
    )
    .limit(1);
  return !!row;
}

export async function listBills(userId: number) {
  return db
    .select()
    .from(financialEntries)
    .where(
      and(
        eq(financialEntries.userId, userId),
        eq(financialEntries.kind, "bill"),
        isNull(financialEntries.deletedAt),
      ),
    )
    .orderBy(asc(financialEntries.dueDate));
}

export async function listIncome(userId: number) {
  return db
    .select()
    .from(incomeEntries)
    .where(and(eq(incomeEntries.userId, userId), isNull(incomeEntries.deletedAt)))
    .orderBy(asc(incomeEntries.payDate));
}

/* --------------------------------------------------------------- mappers --- */

export function toAccountViews(
  rows: Awaited<ReturnType<typeof listAccounts>>,
  linked?: Map<number, LinkedSnapshot>,
): AccountView[] {
  return rows.map((r) => {
    const type = r.type ?? "checking";
    const source = r.balanceSource ?? "manual";
    const base: AccountView = {
      id: r.id,
      name: r.name,
      type,
      institution: r.institution ?? null,
      purpose: r.purpose ?? "other",
      currentBalance: num(r.currentBalance),
      balanceSource: source,
      includeInSpendable: r.includeInSpendable ?? true,
      active: r.active ?? true,
      isCash: isCashType(type),
      isLiability: isLiabilityType(type),
      lastReconciledAt: r.lastReconciledAt ? r.lastReconciledAt.toISOString() : null,
    };
    if (source !== "linked") return base;

    // Finance 1B.2: a linked account's balance comes from the provider snapshot —
    // never the (NULL) currentBalance column. A missing snapshot resolves to
    // "unavailable" (never a fallback to a manual balance or zero).
    const snap = linked?.get(r.id);
    const providerSnapshot =
      snap && snap.balanceCurrent != null
        ? { actual: num(snap.balanceCurrent), asOf: (snap.balanceAsOf ?? new Date()).toISOString(), status: (snap.status === "stale" ? "stale" : "active") as "stale" | "active" }
        : snap
          ? { actual: null, asOf: (snap.balanceAsOf ?? new Date()).toISOString(), status: "active" as const }
          : null;
    const resolved = resolveBalanceAuthority({ balanceSource: "linked", manualBalance: num(r.currentBalance), providerSnapshot });
    return {
      ...base,
      currentBalance: resolved.actual ?? 0,
      balanceUnavailable: resolved.actual == null,
      balanceStale: resolved.kind === "linked_stale",
      balanceAsOf: resolved.asOf,
      balanceAvailable: snap?.balanceAvailable != null ? num(snap.balanceAvailable) : null,
      providerLabel: "Plaid Sandbox",
      currency: snap?.currencyCode ?? null,
    };
  });
}

export function toBillViews(rows: Awaited<ReturnType<typeof listBills>>): BillView[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    expectedAmount: num(r.actualAmount ?? r.expectedAmount),
    dueDate: r.dueDate,
    status: r.status,
    sourceAccountId: r.sourceAccountId ?? null,
    paidAccountId: r.paidAccountId ?? null,
    actualAmount: r.actualAmount != null ? num(r.actualAmount) : null,
    paidAt: r.paidAt ? r.paidAt.toISOString() : null,
  }));
}

/* Finance 1A.1: cash/liability rollups from manually entered actual balances.
 * Pure + deterministic so the verification harness can assert it directly.
 *
 * Rules (owner-decided):
 *   - Only ACTIVE accounts contribute to any total.
 *   - Total actual cash  = Σ balance over active cash-type accounts (assets).
 *   - Spendable cash     = the cash subset whose includeInSpendable is true.
 *   - Savings/emergency  = active accounts whose PURPOSE is savings|emergency
 *                          (still part of total actual cash; surfaced separately).
 *   - Credit liabilities = Σ balance over active credit accounts (amount owed,
 *                          positive). Credit is NEVER added to any cash total.
 *   - netPosition        = totalActualCash − creditLiabilities (informational). */
export function computeCashSummary(accounts: AccountView[]): CashSummary {
  const active = accounts.filter((a) => a.active);
  // A linked account with no provider snapshot is EXCLUDED from totals (never a
  // silent zero) and surfaced as a warning so the total is qualified, not false.
  const known = active.filter((a) => !a.balanceUnavailable);
  const cash = known.filter((a) => a.isCash);
  const credit = known.filter((a) => a.isLiability);

  const totalActualCash = cash.reduce((s, a) => s + a.currentBalance, 0);
  const spendableActualCash = cash
    .filter((a) => a.includeInSpendable)
    .reduce((s, a) => s + a.currentBalance, 0);
  const savingsEmergency = known
    .filter((a) => a.purpose === "savings" || a.purpose === "emergency")
    .reduce((s, a) => s + a.currentBalance, 0);
  const creditLiabilities = credit.reduce((s, a) => s + a.currentBalance, 0);

  const linkedUnavailableCount = active.filter((a) => a.balanceUnavailable).length;
  const linkedStaleCount = active.filter((a) => a.balanceStale).length;

  return {
    totalActualCash,
    spendableActualCash,
    savingsEmergency,
    creditLiabilities,
    netPosition: totalActualCash - creditLiabilities,
    cashAccountCount: cash.length,
    creditAccountCount: credit.length,
    linkedUnavailableCount,
    linkedStaleCount,
    totalQualified: linkedUnavailableCount > 0,
  };
}

export function toIncomeViews(
  rows: Awaited<ReturnType<typeof listIncome>>,
  allocationsByIncome?: Map<number, AllocationView[]>,
): IncomeView[] {
  return rows.map((r) => {
    const expected = num(r.expectedAmount);
    const actual = r.actualAmount != null ? num(r.actualAmount) : null;
    const round2 = (n: number) => Math.round(n * 100) / 100;
    return {
      id: r.id,
      source: r.source,
      // The TRUE expected amount (the estimate); receipt fills actualAmount.
      expectedAmount: expected,
      payDate: r.payDate,
      isPayday: r.isPayday,
      status: r.status ?? "scheduled",
      actualAmount: actual,
      receivedAt: r.receivedAt ? r.receivedAt.toISOString() : null,
      destinationAccountId: r.destinationAccountId ?? null,
      allocations: allocationsByIncome?.get(r.id) ?? [],
      scheduleId: r.scheduleId ?? null,
      estimateType: r.estimateType ?? "fixed",
      expectedMin: r.expectedMin != null ? num(r.expectedMin) : null,
      expectedMax: r.expectedMax != null ? num(r.expectedMax) : null,
      variance: actual != null ? round2(actual - expected) : null,
      variancePct: actual != null && expected > 0 ? round2(((actual - expected) / expected) * 100) : null,
    };
  });
}

/* ------------------------------------------------------------- the outlook --- */

/** Compute the financial outlook from the user's accounts, bills, and income. */
export async function computeFinancialOutlook(
  userId: number,
): Promise<FinancialOutlook> {
  const today = todayIso();
  const [accounts, bills, income] = await Promise.all([
    toAccountViews(await listAccounts(userId)),
    toBillViews(await listBills(userId)),
    toIncomeViews(await listIncome(userId)),
  ]);

  // Legacy compatibility total (kept until Finance 1A.3 replaces estimatedRemaining
  // with account-aware projection). NOT expanded — only corrected so it never
  // counts credit-card debt or inactive accounts as available cash.
  const accountsTotal = accounts
    .filter((a) => a.active && !a.isLiability)
    .reduce((s, a) => s + a.currentBalance, 0);

  const openBills = bills.filter((b) => BILL_OPEN.has(b.status) && b.dueDate);
  const overdueCount = openBills.filter((b) => b.dueDate! < today).length;

  // Next payday: soonest upcoming payday-flagged income, else soonest income.
  const upcoming = income
    .filter((i) => i.payDate >= today)
    .sort((a, b) => a.payDate.localeCompare(b.payDate));
  const nextPayday = upcoming.find((i) => i.isPayday) ?? upcoming[0] ?? null;
  const nextPaydayDate = nextPayday?.payDate ?? null;

  // Income arriving before the next payday (e.g. side income), not the payday itself.
  const expectedIncomeBeforePayday = nextPaydayDate
    ? income
        .filter((i) => i.payDate >= today && i.payDate < nextPaydayDate)
        .reduce((s, i) => s + i.expectedAmount, 0)
    : 0;

  // Bills due on or before the next payday (or within 14 days if no payday known).
  const beforeDate = nextPaydayDate ?? addDays(today, 14);
  const billsDueBeforePayday = openBills
    .filter((b) => b.dueDate! <= beforeDate)
    .reduce((s, b) => s + b.expectedAmount, 0);

  // Cumulative "due within N days" buckets (include overdue, still owed).
  const dueWithin = (n: number) =>
    openBills
      .filter((b) => b.dueDate! <= addDays(today, n))
      .reduce((s, b) => s + b.expectedAmount, 0);

  const estimatedRemaining =
    accountsTotal + expectedIncomeBeforePayday - billsDueBeforePayday;

  return {
    accountsTotal,
    nextPaydayDate,
    expectedIncomeBeforePayday,
    billsDueBeforePayday,
    estimatedRemaining,
    overdueCount,
    due7: dueWithin(7),
    due14: dueWithin(14),
    due30: dueWithin(30),
  };
}

/* ----------------------------------------------------------------- writes --- */

export async function createAccount(input: NewAccount) {
  const [row] = await db.insert(financialAccounts).values(input).returning();
  return row;
}

export async function updateAccount(
  userId: number,
  id: number,
  patch: Partial<NewAccount>,
) {
  // Finance 1B.2: a linked account's balance is provider-authoritative — never a
  // manually editable field. Strip any attempt to set its balance or flip its
  // source. (Reconciliation is already blocked for linked accounts in 1A.3B.)
  const existing = (
    await db.select().from(financialAccounts).where(and(eq(financialAccounts.id, id), eq(financialAccounts.userId, userId)))
  )[0];
  if (existing?.balanceSource === "linked") {
    delete (patch as Record<string, unknown>).currentBalance;
    delete (patch as Record<string, unknown>).balanceSource;
    delete (patch as Record<string, unknown>).lastReconciledAt;
    delete (patch as Record<string, unknown>).balanceUpdatedAt;
  }
  const [row] = await db
    .update(financialAccounts)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(financialAccounts.id, id),
        eq(financialAccounts.userId, userId),
        isNull(financialAccounts.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

export async function deleteAccount(userId: number, id: number) {
  return updateAccount(userId, id, { deletedAt: new Date() } as Partial<NewAccount>);
}

export async function createBill(input: NewBill) {
  const [row] = await db
    .insert(financialEntries)
    .values({ ...input, kind: "bill" })
    .returning();
  return row;
}

export async function updateBill(userId: number, id: number, patch: Partial<NewBill>) {
  const [row] = await db
    .update(financialEntries)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(financialEntries.id, id),
        eq(financialEntries.userId, userId),
        isNull(financialEntries.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/* ---------------------------------------- Finance 1A.3A: payment ledger --- */

/** Open (still-owed) bill statuses. */
const OPEN_STATUSES = ["scheduled", "due", "overdue"] as const;

/** The status an unpaid bill should hold given its due date (local timezone). */
export function openStatusForDueDate(
  dueDate: string | null,
): "scheduled" | "due" | "overdue" {
  if (!dueDate) return "scheduled";
  const d = localDaysUntil(dueDate);
  if (d < 0) return "overdue";
  if (d === 0) return "due";
  return "scheduled";
}

/** A single live bill (kind="bill") owned by this user, or null. */
export async function getBill(userId: number, id: number) {
  const [row] = await db
    .select()
    .from(financialEntries)
    .where(
      and(
        eq(financialEntries.id, id),
        eq(financialEntries.userId, userId),
        eq(financialEntries.kind, "bill"),
        isNull(financialEntries.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Finance 1A.3A — pay a bill.
 *
 * Records the bill as paid with the confirmed actual amount and the account it
 * was paid from. Paying from a MANUAL account atomically (a) flips the bill to
 * paid, (b) deducts the actual amount from that account, and (c) appends ONE
 * negative ledger movement — all in a single writable-CTE statement, all-or-
 * nothing. The transition is guarded by the bill's open status, so a duplicate
 * or concurrent payment finds the bill already paid and deducts nothing.
 *
 * External/cash payment (`paidAccountId == null`) marks the bill paid and
 * changes no balance and writes no movement. A `linked` account is marked paid
 * but never receives a manual deduction (and no movement) — only its bank sync
 * (future Finance 1B) may change its balance.
 *
 * Returns the updated bill row, or null if the bill was not open (not found /
 * already paid). Never throws on the idempotency guard.
 */
export async function payBill(
  userId: number,
  id: number,
  paidAccountId?: number | null,
  actualAmount?: number,
) {
  const bill = await getBill(userId, id);
  if (!bill) return null;
  if (!OPEN_STATUSES.includes(bill.status as (typeof OPEN_STATUSES)[number])) return null;

  const amount = actualAmount != null ? actualAmount : num(bill.expectedAmount);
  const amtStr = amount.toFixed(2);
  const negStr = (-amount).toFixed(2);
  const note = `Bill payment: ${bill.name}`;

  if (paidAccountId == null) {
    // External / cash — no account, no balance change, no movement.
    const res = await db.execute(sql`
      UPDATE financial_entries
         SET status = 'paid', paid_at = now(), paid_account_id = NULL,
             actual_amount = ${amtStr}::numeric, updated_at = now()
       WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NULL
         AND status IN ('scheduled', 'due', 'overdue')
      RETURNING id
    `);
    if (!(res.rows ?? []).length) return null;
    return getBill(userId, id);
  }

  // Account payment. The deduction + movement happen ONLY when the account is
  // manual; a linked account is marked paid with no deduction and no movement.
  const res = await db.execute(sql`
    WITH paid AS (
      UPDATE financial_entries
         SET status = 'paid', paid_at = now(), paid_account_id = ${paidAccountId},
             actual_amount = ${amtStr}::numeric, updated_at = now()
       WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NULL
         AND status IN ('scheduled', 'due', 'overdue')
      RETURNING id
    ),
    acct AS (
      UPDATE financial_accounts
         SET current_balance = current_balance - ${amtStr}::numeric,
             balance_updated_at = now(), updated_at = now()
       WHERE id = ${paidAccountId} AND user_id = ${userId} AND deleted_at IS NULL
         AND balance_source = 'manual'
         AND EXISTS (SELECT 1 FROM paid)
      RETURNING id
    ),
    mov AS (
      INSERT INTO account_movements
        (user_id, account_id, bill_id, kind, amount, note, occurred_at, created_at)
      SELECT ${userId}, ${paidAccountId}, ${id}, 'bill_payment',
             ${negStr}::numeric, ${note}, now(), now()
       WHERE EXISTS (SELECT 1 FROM paid) AND EXISTS (SELECT 1 FROM acct)
      RETURNING id
    )
    SELECT (SELECT id FROM paid) AS bill_id, (SELECT id FROM mov) AS mov_id
  `);
  const row = (res.rows ?? [])[0] as { bill_id: unknown } | undefined;
  if (!row || row.bill_id == null) return null;
  return getBill(userId, id);
}

/**
 * Finance 1A.3A — reverse (undo) a bill payment.
 *
 * Reopens the bill to scheduled/due/overdue (by its due date) and, when the
 * payment had deducted a manual account, atomically credits the account back by
 * the original amount and appends ONE positive reversal movement that points at
 * the original payment. The original payment movement is NEVER deleted. A
 * partial unique index on `reversal_of_id` plus the paid-status guard make a
 * duplicate or concurrent reversal impossible to credit twice. A bill paid
 * externally or before the ledger existed simply reopens (no credit, no movement).
 *
 * Returns the reopened bill row, or null if it was not paid / not found.
 */
export async function reverseBillPayment(userId: number, id: number) {
  const bill = await getBill(userId, id);
  if (!bill) return null;
  if (bill.status !== "paid") return null;
  const reopen = openStatusForDueDate(bill.dueDate);
  const note = `Reversed bill payment: ${bill.name}`;

  try {
    const res = await db.execute(sql`
      WITH reopened AS (
        UPDATE financial_entries
           SET status = ${reopen}::bill_status, paid_at = NULL, paid_account_id = NULL,
               actual_amount = NULL, updated_at = now()
         WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NULL AND status = 'paid'
        RETURNING id
      ),
      pay AS (
        SELECT m.id, m.account_id, m.amount
          FROM account_movements m
         WHERE m.bill_id = ${id} AND m.user_id = ${userId} AND m.kind = 'bill_payment'
           AND NOT EXISTS (
             SELECT 1 FROM account_movements r WHERE r.reversal_of_id = m.id
           )
           AND EXISTS (SELECT 1 FROM reopened)
         ORDER BY m.id DESC
         LIMIT 1
      ),
      credit AS (
        UPDATE financial_accounts
           SET current_balance = current_balance + (SELECT -amount FROM pay),
               balance_updated_at = now(), updated_at = now()
         WHERE id = (SELECT account_id FROM pay) AND user_id = ${userId}
           AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM pay)
        RETURNING id
      ),
      rev AS (
        INSERT INTO account_movements
          (user_id, account_id, bill_id, kind, amount, reversal_of_id, note, occurred_at, created_at)
        SELECT ${userId}, (SELECT account_id FROM pay), ${id}, 'bill_payment_reversal',
               (SELECT -amount FROM pay), (SELECT id FROM pay), ${note}, now(), now()
         WHERE EXISTS (SELECT 1 FROM pay) AND EXISTS (SELECT 1 FROM credit)
        RETURNING id
      )
      SELECT (SELECT id FROM reopened) AS bill_id, (SELECT id FROM rev) AS rev_id
    `);
    const row = (res.rows ?? [])[0] as { bill_id: unknown } | undefined;
    if (!row || row.bill_id == null) return null;
    return getBill(userId, id);
  } catch (err) {
    // A concurrent reversal already credited this payment (unique index on
    // reversal_of_id) — treat as already-reversed; do not double-credit.
    if (String(err).includes("account_movements_reversal_uq")) return null;
    throw err;
  }
}

/** Recent ledger movements (newest first) with account + bill + income names.
 * Covers bill-payment (1A.3A) and income/transfer (1A.2) movement kinds. */
export async function listMovements(userId: number, limit = 12) {
  return db
    .select({
      id: accountMovements.id,
      accountId: accountMovements.accountId,
      accountName: financialAccounts.name,
      billId: accountMovements.billId,
      billName: financialEntries.name,
      incomeId: accountMovements.incomeId,
      incomeSource: incomeEntries.source,
      transferId: accountMovements.transferId,
      kind: accountMovements.kind,
      amount: accountMovements.amount,
      priorBalance: accountMovements.priorBalance,
      newBalance: accountMovements.newBalance,
      occurredAt: accountMovements.occurredAt,
    })
    .from(accountMovements)
    .leftJoin(financialAccounts, eq(accountMovements.accountId, financialAccounts.id))
    .leftJoin(financialEntries, eq(accountMovements.billId, financialEntries.id))
    .leftJoin(incomeEntries, eq(accountMovements.incomeId, incomeEntries.id))
    .where(eq(accountMovements.userId, userId))
    .orderBy(desc(accountMovements.occurredAt), desc(accountMovements.id))
    .limit(limit);
}

export function toMovementViews(
  rows: Awaited<ReturnType<typeof listMovements>>,
): MovementView[] {
  return rows.map((r) => ({
    id: r.id,
    accountId: r.accountId,
    accountName: r.accountName ?? null,
    billId: r.billId ?? null,
    billName: r.billName ?? null,
    incomeId: r.incomeId ?? null,
    incomeSource: r.incomeSource ?? null,
    transferId: r.transferId ?? null,
    kind: r.kind,
    amount: num(r.amount),
    priorBalance: r.priorBalance != null ? num(r.priorBalance) : null,
    newBalance: r.newBalance != null ? num(r.newBalance) : null,
    occurredAt:
      r.occurredAt instanceof Date ? r.occurredAt.toISOString() : String(r.occurredAt),
  }));
}

export async function deleteBill(userId: number, id: number) {
  return updateBill(userId, id, { deletedAt: new Date() } as Partial<NewBill>);
}

/* ============================ Finance 1A.2: income splits + receipt ledger === */

/** Typed error so routes can map validation problems to specific HTTP codes. */
export class FinanceError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "FinanceError";
  }
}

// Pure split-allocation math lives in lib/finance-allocations (no DB) so the
// client preview and the server receipt share exactly one implementation.
import {
  validateAllocationSet,
  computeAllocationShares,
} from "@/lib/finance-allocations";
import type { AllocationInput, AllocationShare } from "@/lib/finance-allocations";
export { validateAllocationSet, computeAllocationShares };
export type { AllocationInput, AllocationShare };

/** A single live income entry owned by this user, or null. */
export async function getIncome(userId: number, id: number) {
  const [row] = await db
    .select()
    .from(incomeEntries)
    .where(and(eq(incomeEntries.id, id), eq(incomeEntries.userId, userId), isNull(incomeEntries.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** All allocation rows for the user, joined with destination account names. */
export async function listAllocations(userId: number) {
  return db
    .select({
      id: incomeAllocations.id,
      incomeId: incomeAllocations.incomeId,
      accountId: incomeAllocations.accountId,
      accountName: financialAccounts.name,
      allocationType: incomeAllocations.allocationType,
      value: incomeAllocations.value,
      position: incomeAllocations.position,
    })
    .from(incomeAllocations)
    .leftJoin(financialAccounts, eq(incomeAllocations.accountId, financialAccounts.id))
    .where(eq(incomeAllocations.userId, userId))
    .orderBy(asc(incomeAllocations.incomeId), asc(incomeAllocations.position));
}

export function allocationsByIncome(
  rows: Awaited<ReturnType<typeof listAllocations>>,
): Map<number, AllocationView[]> {
  const m = new Map<number, AllocationView[]>();
  for (const r of rows) {
    const v: AllocationView = {
      id: r.id,
      accountId: r.accountId,
      accountName: r.accountName ?? null,
      allocationType: r.allocationType,
      value: r.value != null ? num(r.value) : null,
      position: r.position,
    };
    if (!m.has(r.incomeId)) m.set(r.incomeId, []);
    m.get(r.incomeId)!.push(v);
  }
  return m;
}

/** Validate a destination/transfer account: owned, live, active, not credit. */
async function requireCashAccount(userId: number, accountId: number) {
  const a = await getAccount(userId, accountId);
  if (!a) throw new FinanceError(400, "Account not found.");
  if (a.active === false) throw new FinanceError(400, "That account is inactive.");
  if (a.type === "credit")
    throw new FinanceError(400, "Credit accounts can't be an income or transfer destination.");
  return a;
}

/** Set a single destination account for a scheduled income (clears any split). */
export async function setIncomeDestination(
  userId: number,
  incomeId: number,
  accountId: number | null,
) {
  const inc = await getIncome(userId, incomeId);
  if (!inc) throw new FinanceError(404, "Income not found.");
  if (inc.status !== "scheduled")
    throw new FinanceError(409, "Only scheduled income can be re-assigned.");
  if (accountId != null) await requireCashAccount(userId, accountId);
  await db.delete(incomeAllocations).where(eq(incomeAllocations.incomeId, incomeId));
  // Finance 1A.4 correction: an explicit occurrence edit marks it overridden so a
  // later schedule edit never overwrites it.
  return updateIncome(userId, incomeId, { destinationAccountId: accountId, isOverridden: true } as Partial<NewIncome>);
}

/** Replace the split allocations for a scheduled income (sets split mode). */
export async function setIncomeAllocations(
  userId: number,
  incomeId: number,
  allocations: AllocationInput[],
) {
  const inc = await getIncome(userId, incomeId);
  if (!inc) throw new FinanceError(404, "Income not found.");
  if (inc.status !== "scheduled")
    throw new FinanceError(409, "Only scheduled income can be re-allocated.");
  const structural = validateAllocationSet(allocations);
  if (structural) throw new FinanceError(400, structural);
  for (const a of allocations) await requireCashAccount(userId, a.accountId);

  // Replace wholesale; clear single-destination so split mode is unambiguous.
  await db.delete(incomeAllocations).where(eq(incomeAllocations.incomeId, incomeId));
  await db.insert(incomeAllocations).values(
    allocations.map((a, i) => ({
      userId,
      incomeId,
      accountId: a.accountId,
      allocationType: a.allocationType,
      value: a.allocationType === "remainder" || a.value == null ? null : String(a.value),
      position: i,
    })),
  );
  // Mark the occurrence overridden (split mode); clear single-destination.
  return updateIncome(userId, incomeId, { destinationAccountId: null, isOverridden: true } as Partial<NewIncome>);
}

/**
 * Finance 1A.2 — receive a scheduled income.
 *
 * Resolves the destination (single account or split allocations) against the
 * confirmed gross, then atomically marks the income received and, for every
 * MANUAL destination, increases that account's balance and appends one positive
 * `income_received` movement — all in one writable-CTE statement, guarded by
 * `status='scheduled'` so a duplicate/concurrent receipt does nothing. LINKED
 * destinations are not mutated and get no movement (bank-authoritative).
 *
 * Returns the updated income row, or null if it was not scheduled (not found /
 * already received). Throws FinanceError(400) for an unresolvable destination.
 */
export async function receiveIncome(
  userId: number,
  id: number,
  actualAmount?: number,
  receivedDate?: string,
) {
  const inc = await getIncome(userId, id);
  if (!inc) return null;
  if (inc.status !== "scheduled") return null;

  const gross = actualAmount != null ? actualAmount : num(inc.expectedAmount);
  if (!(gross > 0)) throw new FinanceError(400, "Received amount must be positive.");

  // Resolve shares.
  const allocRows = await db
    .select()
    .from(incomeAllocations)
    .where(and(eq(incomeAllocations.incomeId, id), eq(incomeAllocations.userId, userId)))
    .orderBy(asc(incomeAllocations.position));
  let shares: AllocationShare[];
  if (allocRows.length) {
    const res = computeAllocationShares(
      gross,
      allocRows.map((a) => ({
        accountId: a.accountId,
        allocationType: a.allocationType as AllocationInput["allocationType"],
        value: a.value != null ? num(a.value) : null,
      })),
    );
    if (res.error) throw new FinanceError(400, res.error);
    shares = res.shares;
  } else if (inc.destinationAccountId != null) {
    shares = [{ accountId: inc.destinationAccountId, cents: Math.round(gross * 100), type: "single" }];
  } else {
    throw new FinanceError(400, "Assign a destination account or split before receiving this income.");
  }

  // Linked-account income cannot be confirmed manually yet (no bank sync). If ANY
  // destination is linked, reject the WHOLE receipt — never partially credit and
  // never mark a record received it cannot truthfully confirm. The scheduled
  // income is left untouched (no balance change, no movement).
  const accounts = await listAccounts(userId);
  const acctById = new Map(accounts.map((a) => [a.id, a]));
  for (const s of shares) {
    const a = acctById.get(s.accountId);
    if (!a) throw new FinanceError(400, "A destination account no longer exists.");
    if (a.balanceSource === "linked")
      throw new FinanceError(
        400,
        "Linked-account income must be confirmed through a future bank sync. Use a manual account for now.",
      );
  }
  // Every destination is a live manual account.
  const manualShares = shares;
  const note = `Income received: ${inc.source}`;
  const grossStr = gross.toFixed(2);
  const receivedAtSql = receivedDate ? sql`${receivedDate}::date` : sql`now()`;

  // Cast the VALUES columns explicitly — untyped bound params default to text,
  // which won't compare against the integer account id / numeric balance.
  const valueRows = manualShares.map(
    (s) => sql`(${s.accountId}::int, ${(s.cents / 100).toFixed(2)}::numeric)`,
  );
  const res = await db.execute(sql`
    WITH recv AS (
      UPDATE income_entries
         SET status = 'received', received_at = ${receivedAtSql},
             actual_amount = ${grossStr}::numeric, updated_at = now()
       WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NULL AND status = 'scheduled'
      RETURNING id
    ),
    alloc (account_id, amt) AS ( VALUES ${sql.join(valueRows, sql`, `)} ),
    upd AS (
      UPDATE financial_accounts fa
         SET current_balance = fa.current_balance + a.amt,
             balance_updated_at = now(), updated_at = now()
        FROM alloc a
       WHERE fa.id = a.account_id AND fa.user_id = ${userId} AND fa.deleted_at IS NULL
         AND fa.balance_source = 'manual' AND EXISTS (SELECT 1 FROM recv)
      RETURNING fa.id
    ),
    ins AS (
      INSERT INTO account_movements
        (user_id, account_id, income_id, kind, amount, note, occurred_at, created_at)
      SELECT ${userId}, a.account_id, ${id}, 'income_received', a.amt, ${note}, now(), now()
        FROM alloc a WHERE EXISTS (SELECT 1 FROM recv)
      RETURNING id
    )
    SELECT (SELECT id FROM recv) AS income_id, (SELECT count(*)::int FROM ins) AS n
  `);
  const row = (res.rows ?? [])[0] as { income_id: unknown } | undefined;
  if (!row || row.income_id == null) return null;
  return getIncome(userId, id);
}

/**
 * Finance 1A.2 — undo an income receipt.
 *
 * Returns the income to `scheduled` and, for every MANUAL `income_received`
 * movement, atomically decreases the account back and appends one negative
 * `income_reversal` movement pointing at the original (which is never deleted).
 * Guarded by `status='received'` + the partial unique index on `reversal_of_id`
 * so a duplicate/concurrent reversal cannot subtract twice.
 */
export async function reverseIncomeReceipt(userId: number, id: number) {
  const inc = await getIncome(userId, id);
  if (!inc) return null;
  if (inc.status !== "received") return null;
  const note = `Income receipt reversed: ${inc.source}`;
  try {
    const res = await db.execute(sql`
      WITH reopened AS (
        UPDATE income_entries
           SET status = 'scheduled', received_at = NULL, actual_amount = NULL, updated_at = now()
         WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NULL AND status = 'received'
        RETURNING id
      ),
      orig AS (
        SELECT m.id, m.account_id, m.amount
          FROM account_movements m
         WHERE m.income_id = ${id} AND m.user_id = ${userId} AND m.kind = 'income_received'
           AND NOT EXISTS (SELECT 1 FROM account_movements r WHERE r.reversal_of_id = m.id)
           AND EXISTS (SELECT 1 FROM reopened)
      ),
      dec AS (
        UPDATE financial_accounts fa
           SET current_balance = fa.current_balance - s.amt,
               balance_updated_at = now(), updated_at = now()
          FROM (SELECT account_id, sum(amount) AS amt FROM orig GROUP BY account_id) s
         WHERE fa.id = s.account_id AND fa.user_id = ${userId} AND fa.deleted_at IS NULL
           AND fa.balance_source = 'manual' AND EXISTS (SELECT 1 FROM orig)
        RETURNING fa.id
      ),
      rev AS (
        INSERT INTO account_movements
          (user_id, account_id, income_id, kind, amount, reversal_of_id, note, occurred_at, created_at)
        SELECT ${userId}, o.account_id, ${id}, 'income_reversal', -o.amount, o.id, ${note}, now(), now()
          FROM orig o WHERE EXISTS (SELECT 1 FROM reopened)
        RETURNING id
      )
      SELECT (SELECT id FROM reopened) AS income_id
    `);
    const row = (res.rows ?? [])[0] as { income_id: unknown } | undefined;
    if (!row || row.income_id == null) return null;
    return getIncome(userId, id);
  } catch (err) {
    if (String(err).includes("account_movements_reversal_uq")) return null;
    throw err;
  }
}

export { requireCashAccount };

/** Finance 1A.4: set an occurrence's open status (skip / cancel / un-skip back to
 * scheduled). A received occurrence must be reversed first. Skipped/cancelled
 * occurrences are excluded from projection but preserved as history. */
export const OCCURRENCE_STATUSES = ["scheduled", "skipped", "cancelled"] as const;
export async function setIncomeStatus(
  userId: number,
  id: number,
  status: (typeof OCCURRENCE_STATUSES)[number],
) {
  if (!OCCURRENCE_STATUSES.includes(status)) throw new FinanceError(400, "Invalid status.");
  const inc = await getIncome(userId, id);
  if (!inc) throw new FinanceError(404, "Income not found.");
  if (inc.status === "received")
    throw new FinanceError(409, "Reverse the receipt before changing this occurrence's status.");
  const [row] = await db
    .update(incomeEntries)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(incomeEntries.id, id), eq(incomeEntries.userId, userId), isNull(incomeEntries.deletedAt)))
    .returning();
  return row ?? null;
}

/* ============================ Finance 1A.3B: reconciliation ledger ========== */

/** Account ids whose latest reconciliation is CURRENTLY reversible — i.e. there
 * is an unreversed `reconcile_adjustment` whose `occurred_at` still equals the
 * account's `lastReconciledAt` and whose `new_balance` still equals the current
 * balance (exactly the reverseReconciliation guard). A later reconcile (incl. a
 * zero-delta verification) advances `lastReconciledAt` and drops the account, so
 * the UI never offers Undo for an event the server would reject. */
export async function getReconcilableAccountIds(userId: number): Promise<number[]> {
  const res = await db.execute(sql`
    SELECT m.account_id AS id
      FROM account_movements m
      JOIN financial_accounts fa ON fa.id = m.account_id
     WHERE m.user_id = ${userId} AND m.kind = 'reconcile_adjustment'
       AND fa.user_id = ${userId} AND fa.deleted_at IS NULL AND fa.balance_source = 'manual'
       AND fa.last_reconciled_at = m.occurred_at
       AND fa.current_balance = m.new_balance
       AND NOT EXISTS (SELECT 1 FROM account_movements r WHERE r.reversal_of_id = m.id)
  `);
  return (res.rows ?? []).map((r) => Number((r as { id: unknown }).id));
}

/**
 * Reconcile a manual account to the real bank balance. Atomically sets the
 * actual balance to `realBalance`, stamps `lastReconciledAt`, and — when the
 * delta is non-zero — appends ONE append-only `reconcile_adjustment` movement
 * recording the signed delta + prior/new balance. A zero delta updates only the
 * timestamp (no meaningless movement). Optimistic guard (`current_balance =
 * prior`) makes a duplicate/concurrent reconcile apply at most once: the loser
 * matches 0 rows. Never deletes or rewrites prior movements.
 *
 * Returns the updated account, or null on a stale/concurrent conflict. Throws
 * FinanceError for linked/inactive/missing accounts.
 */
export async function reconcileAccount(
  userId: number,
  id: number,
  realBalance: number,
  note?: string | null,
) {
  const account = await getAccount(userId, id);
  if (!account) throw new FinanceError(404, "Account not found.");
  if (account.balanceSource !== "manual")
    throw new FinanceError(
      400,
      "Only manual accounts can be reconciled — a linked balance is bank-authoritative.",
    );
  if (account.active === false) throw new FinanceError(400, "That account is inactive.");

  const prior = num(account.currentBalance);
  const real = Math.round(realBalance * 100) / 100;
  const delta = Math.round((real - prior) * 100) / 100;
  const priorStr = prior.toFixed(2), realStr = real.toFixed(2), deltaStr = delta.toFixed(2);
  const noteVal = note && note.trim() ? note.trim() : null;

  const res = await db.execute(sql`
    WITH upd AS (
      UPDATE financial_accounts
         SET current_balance = ${realStr}::numeric, last_reconciled_at = now(),
             balance_updated_at = now(), updated_at = now()
       WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NULL
         AND balance_source = 'manual' AND active = true
         AND current_balance = ${priorStr}::numeric
      RETURNING id
    ),
    mov AS (
      INSERT INTO account_movements
        (user_id, account_id, kind, amount, prior_balance, new_balance, note, occurred_at, created_at)
      SELECT ${userId}, ${id}, 'reconcile_adjustment', ${deltaStr}::numeric,
             ${priorStr}::numeric, ${realStr}::numeric, ${noteVal}, now(), now()
       WHERE EXISTS (SELECT 1 FROM upd) AND ${deltaStr}::numeric <> 0
      RETURNING id
    )
    SELECT (SELECT id FROM upd) AS acct, (SELECT id FROM mov) AS mov
  `);
  const row = (res.rows ?? [])[0] as { acct: unknown } | undefined;
  if (!row || row.acct == null) return null; // stale prior / concurrent change
  return getAccount(userId, id);
}

/**
 * Undo the LATEST unreversed reconciliation for a manual account: restores the
 * prior balance, restores `lastReconciledAt` to the previous unreversed
 * reconcile (or null), and appends an equal-and-opposite `reconcile_reversal`
 * movement pointing at the original (never deleted). Only allowed while it is
 * the latest reconcile AND the balance still equals the reconciled value (so an
 * intervening ledger event blocks the undo). The `reversal_of_id` unique index
 * makes a duplicate/concurrent undo impossible.
 *
 * Returns the restored account, or null if there is nothing safely reversible.
 */
export async function reverseReconciliation(userId: number, id: number) {
  const account = await getAccount(userId, id);
  if (!account) throw new FinanceError(404, "Account not found.");
  if (account.balanceSource !== "manual")
    throw new FinanceError(400, "Only manual accounts can be reconciled.");
  const note = "Reconciliation undone";
  try {
    const res = await db.execute(sql`
      WITH target AS (
        SELECT m.id, m.amount, m.prior_balance, m.new_balance, m.occurred_at
          FROM account_movements m
         WHERE m.account_id = ${id} AND m.user_id = ${userId} AND m.kind = 'reconcile_adjustment'
           AND NOT EXISTS (SELECT 1 FROM account_movements r WHERE r.reversal_of_id = m.id)
         ORDER BY m.id DESC LIMIT 1
      ),
      guard AS (
        -- Reversible only when the adjustment is the latest unreversed one AND the
        -- balance is unchanged AND lastReconciledAt still points at THIS adjustment
        -- (so a later reconcile — including a zero-delta verification — makes it
        -- ineligible). Timestamps are compared in SQL: both were written from the
        -- same statement now(), so equality is exact and serialization-robust.
        SELECT t.* FROM target t
         WHERE EXISTS (
           SELECT 1 FROM financial_accounts fa
            WHERE fa.id = ${id} AND fa.user_id = ${userId} AND fa.deleted_at IS NULL
              AND fa.balance_source = 'manual' AND fa.current_balance = t.new_balance
              AND fa.last_reconciled_at = t.occurred_at
         )
      ),
      restore AS (
        UPDATE financial_accounts fa
           SET current_balance = (SELECT prior_balance FROM guard),
               last_reconciled_at = (
                 SELECT m2.occurred_at FROM account_movements m2
                  WHERE m2.account_id = ${id} AND m2.user_id = ${userId}
                    AND m2.kind = 'reconcile_adjustment' AND m2.id <> (SELECT id FROM guard)
                    AND NOT EXISTS (SELECT 1 FROM account_movements r WHERE r.reversal_of_id = m2.id)
                  ORDER BY m2.id DESC LIMIT 1
               ),
               balance_updated_at = now(), updated_at = now()
         WHERE fa.id = ${id} AND EXISTS (SELECT 1 FROM guard)
        RETURNING fa.id
      ),
      rev AS (
        INSERT INTO account_movements
          (user_id, account_id, kind, amount, prior_balance, new_balance, reversal_of_id, note, occurred_at, created_at)
        SELECT ${userId}, ${id}, 'reconcile_reversal', -(SELECT amount FROM guard),
               (SELECT new_balance FROM guard), (SELECT prior_balance FROM guard),
               (SELECT id FROM guard), ${note}, now(), now()
         WHERE EXISTS (SELECT 1 FROM guard) AND EXISTS (SELECT 1 FROM restore)
        RETURNING id
      )
      SELECT (SELECT id FROM restore) AS acct, (SELECT id FROM rev) AS rev
    `);
    const row = (res.rows ?? [])[0] as { acct: unknown } | undefined;
    if (!row || row.acct == null) return null;
    return getAccount(userId, id);
  } catch (err) {
    if (String(err).includes("account_movements_reversal_uq")) return null;
    throw err;
  }
}

export async function createIncome(input: NewIncome) {
  const [row] = await db.insert(incomeEntries).values(input).returning();
  return row;
}

export async function updateIncome(
  userId: number,
  id: number,
  patch: Partial<NewIncome>,
) {
  const [row] = await db
    .update(incomeEntries)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(incomeEntries.id, id),
        eq(incomeEntries.userId, userId),
        isNull(incomeEntries.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

export async function deleteIncome(userId: number, id: number) {
  return updateIncome(userId, id, { deletedAt: new Date() } as Partial<NewIncome>);
}
