/* Finance 1A.3B — deterministic account-aware projection (pure; no DB).
 *
 * Projected balance = actual balance + scheduled inflows − scheduled outflows,
 * within a forecast horizon. It NEVER overwrites the actual balance, and a
 * projected figure is never presented as a current, live, or spendable-now
 * balance — it is explicitly a forecast. Only SCHEDULED items project;
 * received/completed/paid items already live in the actual balance and are never
 * counted again. Unassigned and linked-account items are surfaced, never guessed
 * into an account. The same fixed → percent-of-remaining → remainder algorithm
 * used at receipt resolves split-income forecasts. */

import { computeAllocationShares, type AllocationInput } from "@/lib/finance-allocations";
import type {
  AccountView,
  BillView,
  IncomeView,
  TransferView,
  FinanceProjection,
  AccountProjection,
  ForecastItem,
  ProjectionHorizon,
} from "@/lib/types";

const OPEN_BILL = new Set(["scheduled", "due", "overdue"]);
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const sum = <T>(arr: T[], f: (x: T) => number) => arr.reduce((s, x) => s + f(x), 0);
const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

/** Pure UTC-string date math (dates are stored/compared as YYYY-MM-DD). */
export function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Next payday: soonest upcoming payday-flagged scheduled income, else soonest
 * upcoming scheduled income. Received income is never a future payday. */
/** The next upcoming SCHEDULED income occurrence and what kind it is. A recurring
 * PAYDAY (an occurrence linked to a schedule and flagged isPayday) → "payday"; a
 * one-time / non-payroll income → "scheduled"; nothing upcoming → "none". */
export function nextIncome(
  income: IncomeView[],
  today: string,
): { kind: "payday" | "scheduled" | "none"; date: string | null } {
  const upcoming = income
    .filter((i) => i.status === "scheduled" && i.payDate >= today)
    .sort((a, b) => a.payDate.localeCompare(b.payDate));
  if (!upcoming.length) return { kind: "none", date: null };
  const payday = upcoming.find((i) => i.scheduleId != null && i.isPayday);
  if (payday) return { kind: "payday", date: payday.payDate };
  return { kind: "scheduled", date: upcoming[0].payDate };
}

export function nextPaydayDate(income: IncomeView[], today: string): string | null {
  return nextIncome(income, today).date;
}

/** The amount a scheduled occurrence contributes to projected cash, by estimate
 * mode: fixed/typical → expected; range → minimum (conservative); unknown → $0
 * (the payday still appears, but adds nothing to projected cash). */
export function estimatedProjectionAmount(i: IncomeView): number {
  if (i.estimateType === "unknown") return 0;
  if (i.estimateType === "range") return i.expectedMin ?? 0;
  return i.expectedAmount;
}

/** Resolve a horizon to a concrete end date + label. "payday" claims a payday
 * only when a true recurring payday occurrence exists; otherwise it names the
 * next scheduled income, with a deterministic 14-day fallback. */
export function resolveHorizon(
  horizon: ProjectionHorizon,
  income: IncomeView[],
  today: string,
): { date: string; label: string } {
  if (horizon === "7d") return { date: addDays(today, 7), label: "Next 7 days" };
  if (horizon === "30d") return { date: addDays(today, 30), label: "Next 30 days" };
  const ni = nextIncome(income, today);
  if (ni.kind === "payday") return { date: ni.date!, label: "Until next expected payday" };
  if (ni.kind === "scheduled") return { date: ni.date!, label: "Until next scheduled income" };
  return { date: addDays(today, 14), label: "Next 14 days (no upcoming income)" };
}

export interface ProjectionInput {
  accounts: AccountView[];
  bills: BillView[];
  income: IncomeView[];
  transfers: TransferView[];
  horizon: ProjectionHorizon;
  today: string;
}

export function computeProjection(input: ProjectionInput): FinanceProjection {
  const { accounts, bills, income, transfers, horizon, today } = input;
  const { date: horizonDate, label: horizonLabel } = resolveHorizon(horizon, income, today);
  const payday = nextPaydayDate(income, today);

  const active = accounts.filter((a) => a.active);
  const acctById = new Map(active.map((a) => [a.id, a]));

  const proj = new Map<number, AccountProjection>();
  for (const a of active) {
    proj.set(a.id, {
      accountId: a.id, name: a.name, type: a.type, balanceSource: a.balanceSource,
      isCash: a.isCash, isLiability: a.isLiability, includeInSpendable: a.includeInSpendable,
      purpose: a.purpose, actualBalance: a.currentBalance, scheduledInflows: 0,
      scheduledOutflows: 0, projectedBalance: a.currentBalance, belowZero: false,
    });
  }

  const items: ForecastItem[] = [];
  const unassignedBills: FinanceProjection["unassignedBills"] = [];
  const unassignedIncome: FinanceProjection["unassignedIncome"] = [];
  const linkedSkipped: FinanceProjection["linkedSkipped"] = [];
  const withinHorizon = (d: string | null) => d != null && d <= horizonDate;

  // BILLS — only OPEN bills (paid/skipped/cancelled never project) within horizon.
  for (const b of bills) {
    if (!OPEN_BILL.has(b.status) || !withinHorizon(b.dueDate)) continue;
    const amt = b.expectedAmount;
    if (b.sourceAccountId == null) {
      unassignedBills.push({ id: b.id, name: b.name, amount: amt, dueDate: b.dueDate });
      items.push({ date: b.dueDate, kind: "bill", accountId: null, accountName: null, amount: -amt, label: `Bill: ${b.name} (unassigned)`, resultingBalance: null });
      continue;
    }
    const acct = acctById.get(b.sourceAccountId);
    if (!acct || acct.balanceSource !== "manual") {
      linkedSkipped.push({ kind: "bill", label: `Bill “${b.name}” from a linked/inactive account` });
      items.push({ date: b.dueDate, kind: "bill", accountId: acct?.id ?? null, accountName: acct?.name ?? null, amount: -amt, label: `Bill: ${b.name} (not projected)`, resultingBalance: null });
      continue;
    }
    proj.get(acct.id)!.scheduledOutflows += amt;
    items.push({ date: b.dueDate, kind: "bill", accountId: acct.id, accountName: acct.name, amount: -amt, label: `Bill: ${b.name}`, resultingBalance: null });
  }

  // INCOME — only SCHEDULED income projects (received/cancelled/skipped never do)
  // within horizon. Estimate mode sets the amount: fixed/typical → expected;
  // range → minimum; unknown → $0 (the payday still appears, adds nothing).
  for (const i of income) {
    if (i.status !== "scheduled" || !withinHorizon(i.payDate)) continue;
    const estTag = i.estimateType === "range" ? "estimated range" : i.estimateType === "unknown" ? "amount unknown" : "estimated";
    const gross = estimatedProjectionAmount(i);
    if (gross <= 0) {
      // Unknown / zero estimate — show the payday, contribute $0 to projection.
      const destName = i.destinationAccountId != null ? (acctById.get(i.destinationAccountId)?.name ?? null) : i.allocations.length ? "split" : null;
      items.push({ date: i.payDate, kind: "income", accountId: i.destinationAccountId ?? null, accountName: destName, amount: 0, label: `Income: ${i.source} (amount unknown)`, resultingBalance: null });
      continue;
    }
    let shares: { accountId: number; cents: number }[] | null;
    if (i.allocations.length) {
      const res = computeAllocationShares(
        gross,
        i.allocations.map((a) => ({ accountId: a.accountId, allocationType: a.allocationType as AllocationInput["allocationType"], value: a.value })),
      );
      shares = res.error ? null : res.shares;
    } else if (i.destinationAccountId != null) {
      shares = [{ accountId: i.destinationAccountId, cents: Math.round(gross * 100) }];
    } else {
      shares = null;
    }
    if (!shares) {
      unassignedIncome.push({ id: i.id, source: i.source, amount: gross, payDate: i.payDate });
      items.push({ date: i.payDate, kind: "income", accountId: null, accountName: null, amount: gross, label: `Income: ${i.source} (${estTag}, destination not assigned)`, resultingBalance: null });
      continue;
    }
    for (const s of shares) {
      const acct = acctById.get(s.accountId);
      const dollars = round2(s.cents / 100);
      if (!acct || acct.balanceSource !== "manual") {
        linkedSkipped.push({ kind: "income", label: `Income “${i.source}” to a linked/inactive account` });
        items.push({ date: i.payDate, kind: "income", accountId: acct?.id ?? null, accountName: acct?.name ?? null, amount: dollars, label: `Income: ${i.source} (not projected)`, resultingBalance: null });
        continue;
      }
      proj.get(acct.id)!.scheduledInflows += dollars;
      items.push({ date: i.payDate, kind: "income", accountId: acct.id, accountName: acct.name, amount: dollars, label: `Income: ${i.source} (${estTag})`, resultingBalance: null });
    }
  }

  // TRANSFERS — only SCHEDULED (completed/reversed already in actual) within horizon.
  for (const t of transfers) {
    if (t.status !== "scheduled" || !withinHorizon(t.scheduledDate)) continue;
    const from = acctById.get(t.fromAccountId);
    const to = acctById.get(t.toAccountId);
    if (from?.balanceSource !== "manual" || to?.balanceSource !== "manual") {
      linkedSkipped.push({ kind: "transfer", label: `Transfer ${from?.name ?? "?"} → ${to?.name ?? "?"} involves a linked account` });
      continue;
    }
    proj.get(from.id)!.scheduledOutflows += t.amount;
    proj.get(to.id)!.scheduledInflows += t.amount;
    items.push({ date: t.scheduledDate, kind: "transfer_out", accountId: from.id, accountName: from.name, amount: -t.amount, label: `Transfer to ${to.name}`, resultingBalance: null });
    items.push({ date: t.scheduledDate, kind: "transfer_in", accountId: to.id, accountName: to.name, amount: t.amount, label: `Transfer from ${from.name}`, resultingBalance: null });
  }

  // Finalize per-account projected balances.
  for (const p of proj.values()) {
    p.scheduledInflows = round2(p.scheduledInflows);
    p.scheduledOutflows = round2(p.scheduledOutflows);
    p.projectedBalance = round2(p.actualBalance + p.scheduledInflows - p.scheduledOutflows);
    if (p.isCash && p.projectedBalance < -0.005) p.belowZero = true;
  }

  // Running resulting balance per manual account, applied in date order.
  const running = new Map<number, number>();
  for (const a of active) running.set(a.id, a.currentBalance);
  const dated = items
    .filter((x) => x.accountId != null && x.date != null && acctById.get(x.accountId)?.balanceSource === "manual")
    .sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : 0));
  for (const it of dated) {
    const cur = round2(running.get(it.accountId!)! + it.amount);
    running.set(it.accountId!, cur);
    it.resultingBalance = cur;
  }

  const cash = active.filter((a) => a.isCash);
  const credit = active.filter((a) => a.isLiability);
  const projOf = (a: AccountView) => proj.get(a.id)!.projectedBalance;
  const savEm = active.filter((a) => a.purpose === "savings" || a.purpose === "emergency");
  const totals = {
    totalActualCash: round2(sum(cash, (a) => a.currentBalance)),
    totalProjectedCash: round2(sum(cash, projOf)),
    spendableActualCash: round2(sum(cash.filter((a) => a.includeInSpendable), (a) => a.currentBalance)),
    spendableProjectedCash: round2(sum(cash.filter((a) => a.includeInSpendable), projOf)),
    savingsEmergencyActual: round2(sum(savEm, (a) => a.currentBalance)),
    savingsEmergencyProjected: round2(sum(savEm, projOf)),
    creditLiabilities: round2(sum(credit, (a) => a.currentBalance)),
  };

  const warnings: FinanceProjection["warnings"] = [];
  for (const p of proj.values()) {
    if (p.belowZero)
      warnings.push({ code: "shortfall", message: `${p.name} may fall below $0 (projected ${money(p.projectedBalance)}) ${horizonLabel.toLowerCase()}.` });
  }
  if (unassignedBills.length)
    warnings.push({ code: "unassigned_bill", message: `${unassignedBills.length} upcoming bill(s) have no payment account — not included in any account projection.` });
  if (unassignedIncome.length)
    warnings.push({ code: "unassigned_income", message: `${unassignedIncome.length} scheduled income(s) have no destination — not added to any account projection.` });
  if (linkedSkipped.length)
    warnings.push({ code: "linked_skipped", message: `${linkedSkipped.length} scheduled item(s) involve a linked account and aren't projected (awaiting future bank sync).` });

  // Timeline sorted by date for display.
  items.sort((a, b) => (a.date ?? "9999-99-99").localeCompare(b.date ?? "9999-99-99"));

  const ni = nextIncome(income, today);
  return {
    horizon, horizonLabel, horizonDate, nextPaydayDate: payday,
    nextIncomeKind: ni.kind, nextIncomeDate: ni.date,
    accounts: [...proj.values()], items, totals, warnings,
    unassignedBills, unassignedIncome, linkedSkipped,
  };
}
