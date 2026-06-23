/* Finances service.
 *
 * Holds the real computeFinancialOutlook() the README calls for, plus CRUD for
 * the three underlying tables: accounts (balances), bills (financialEntries
 * with kind="bill"), and income (incomeEntries / paydays).
 *
 * The Neon HTTP driver returns numeric columns as strings, so every money value
 * is parsed with num() before arithmetic. */

import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { financialAccounts, financialEntries, incomeEntries } from "@/db/schema";
import type {
  AccountView,
  BillView,
  CashSummary,
  IncomeView,
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

/* Finance 1A.1: marking a bill paid records status + paidAt + the account it was
 * actually paid from. It deliberately does NOT change any account balance —
 * balances stay manually entered until the recorded-movements ledger lands in
 * Finance 1A.3. paidAccountId is optional (an owner may not track which account). */
export async function payBill(userId: number, id: number, paidAccountId?: number | null) {
  const patch: Partial<NewBill> = { status: "paid", paidAt: new Date() };
  if (paidAccountId !== undefined) patch.paidAccountId = paidAccountId;
  return updateBill(userId, id, patch);
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
