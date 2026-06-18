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
  IncomeView,
  FinancialOutlook,
} from "@/lib/types";

export type NewAccount = typeof financialAccounts.$inferInsert;
export type NewBill = typeof financialEntries.$inferInsert;
export type NewIncome = typeof incomeEntries.$inferInsert;

/* Shared with the API routes (kept out of route.ts per Next.js export rules). */
export const BILL_STATUSES = ["scheduled", "due", "paid", "overdue", "skipped"] as const;

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
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type ?? "checking",
    currentBalance: num(r.currentBalance),
  }));
}

export function toBillViews(rows: Awaited<ReturnType<typeof listBills>>): BillView[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    expectedAmount: num(r.actualAmount ?? r.expectedAmount),
    dueDate: r.dueDate,
    status: r.status,
  }));
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

  const accountsTotal = accounts.reduce((s, a) => s + a.currentBalance, 0);

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

export async function payBill(userId: number, id: number) {
  return updateBill(userId, id, { status: "paid", paidAt: new Date() });
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
