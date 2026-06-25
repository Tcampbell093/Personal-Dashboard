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
  accountMovements,
} from "@/db/schema";
import { localDaysUntil } from "@/lib/time";
import type {
  AccountView,
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

// Account types whose (positive) balance is spendable cash. Credit is a
// liability and `other` is unclassified — neither counts as cash.
export const CASH_TYPES = new Set(["checking", "savings", "cash"]);
export const isCashType = (type: string) => CASH_TYPES.has(type);
export const isLiabilityType = (type: string) => type === "credit";

const num = (v: string | null | undefined): number => (v ? parseFloat(v) : 0);
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
): AccountView[] {
  return rows.map((r) => {
    const type = r.type ?? "checking";
    return {
      id: r.id,
      name: r.name,
      type,
      institution: r.institution ?? null,
      purpose: r.purpose ?? "other",
      currentBalance: num(r.currentBalance),
      balanceSource: r.balanceSource ?? "manual",
      includeInSpendable: r.includeInSpendable ?? true,
      active: r.active ?? true,
      isCash: isCashType(type),
      isLiability: isLiabilityType(type),
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
  const cash = active.filter((a) => a.isCash);
  const credit = active.filter((a) => a.isLiability);

  const totalActualCash = cash.reduce((s, a) => s + a.currentBalance, 0);
  const spendableActualCash = cash
    .filter((a) => a.includeInSpendable)
    .reduce((s, a) => s + a.currentBalance, 0);
  const savingsEmergency = active
    .filter((a) => a.purpose === "savings" || a.purpose === "emergency")
    .reduce((s, a) => s + a.currentBalance, 0);
  const creditLiabilities = credit.reduce((s, a) => s + a.currentBalance, 0);

  return {
    totalActualCash,
    spendableActualCash,
    savingsEmergency,
    creditLiabilities,
    netPosition: totalActualCash - creditLiabilities,
    cashAccountCount: cash.length,
    creditAccountCount: credit.length,
  };
}

export function toIncomeViews(
  rows: Awaited<ReturnType<typeof listIncome>>,
): IncomeView[] {
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    expectedAmount: num(r.actualAmount ?? r.expectedAmount),
    payDate: r.payDate,
    isPayday: r.isPayday,
  }));
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

/** Recent bill-payment ledger movements (newest first) with account + bill names. */
export async function listMovements(userId: number, limit = 8) {
  return db
    .select({
      id: accountMovements.id,
      accountId: accountMovements.accountId,
      accountName: financialAccounts.name,
      billId: accountMovements.billId,
      billName: financialEntries.name,
      kind: accountMovements.kind,
      amount: accountMovements.amount,
      occurredAt: accountMovements.occurredAt,
    })
    .from(accountMovements)
    .leftJoin(financialAccounts, eq(accountMovements.accountId, financialAccounts.id))
    .leftJoin(financialEntries, eq(accountMovements.billId, financialEntries.id))
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
    kind: r.kind,
    amount: num(r.amount),
    occurredAt:
      r.occurredAt instanceof Date ? r.occurredAt.toISOString() : String(r.occurredAt),
  }));
}

export async function deleteBill(userId: number, id: number) {
  return updateBill(userId, id, { deletedAt: new Date() } as Partial<NewBill>);
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
