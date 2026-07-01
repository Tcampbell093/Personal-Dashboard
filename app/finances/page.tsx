/* /finances — the dedicated money workspace (Finance 1A.1 + 1A.3A + 1A.2 + 1A.3B).
 *
 * Account-aware manual finance: accounts with truthful cash/liability totals +
 * manual reconciliation, bills grouped by paying account, income (single or
 * split), transfers, an append-only activity ledger, and a DETERMINISTIC
 * projection (actual + scheduled inflows − scheduled outflows within a horizon).
 * Actual balances are always manually entered; projected balances are clearly
 * separate and are never called current / live / available / safe-to-spend. */

import { getCurrentUserId } from "@/lib/auth";
import { localToday } from "@/lib/time";
import {
  listAccounts,
  toAccountViews,
  listBills,
  toBillViews,
  listIncome,
  toIncomeViews,
  listAllocations,
  allocationsByIncome,
  computeCashSummary,
  listMovements,
  toMovementViews,
  getReconcilableAccountIds,
} from "@/lib/services/finances";
import { listTransfers, toTransferViews } from "@/lib/services/transfers";
import {
  replenishOccurrences,
  listSchedules,
  listScheduleAllocations,
  scheduleAllocationsBySchedule,
  toScheduleViews,
} from "@/lib/services/income-schedules";
import { computeProjection } from "@/lib/services/finance-projection";
import { listConnections } from "@/lib/services/connections";
import { getAutoSyncStatus } from "@/lib/services/webhooks";
import { linkedBalanceMap } from "@/lib/services/provider-accounts";
import { isAuthConfigured } from "@/lib/session";
import { LogoutButton } from "@/components/logout-button";
import { AccountManager } from "@/components/finances/account-manager";
import { BillManager } from "@/components/finances/bill-manager";
import { IncomeManager } from "@/components/finances/income-manager";
import { ScheduleManager } from "@/components/finances/schedule-manager";
import { TransferManager } from "@/components/finances/transfer-manager";
import { ConnectionManager } from "@/components/finances/connection-manager";
import { ImportedActivity } from "@/components/finances/imported-activity";
import { SuggestedMatches } from "@/components/finances/suggested-matches";
import { countPendingMatches } from "@/lib/services/matching";
import { Categorize } from "@/components/finances/categorize";
import { categorySummary } from "@/lib/services/categories";
import { SpendingInsights } from "@/components/finances/insights";
import { CreditHealth } from "@/components/finances/credit";
import type { MovementView, ProjectionHorizon, ForecastItem, ConnectionView } from "@/lib/types";

const HORIZONS: { key: ProjectionHorizon; label: string }[] = [
  { key: "7d", label: "7 days" },
  { key: "payday", label: "Until next payday" },
  { key: "30d", label: "30 days" },
];
const FORECAST_LABEL: Record<string, string> = {
  income: "Income",
  bill: "Bill",
  transfer_out: "Transfer out",
  transfer_in: "Transfer in",
};

const MOVEMENT_LABEL: Record<string, string> = {
  bill_payment: "Bill payment",
  bill_payment_reversal: "Reversed bill payment",
  income_received: "Income received",
  income_reversal: "Reversed income",
  transfer_out: "Transfer out",
  transfer_in: "Transfer in",
  transfer_out_reversal: "Reversed transfer out",
  transfer_in_reversal: "Reversed transfer in",
};

function movementContext(m: MovementView): string {
  if (m.billName) return ` · ${m.billName}`;
  if (m.incomeSource) return ` · ${m.incomeSource}`;
  if (m.transferId) return ` · transfer #${m.transferId}`;
  return "";
}

// Always render fresh; this page reflects live database state and never serves
// cached or mock personal finance data.
export const dynamic = "force-dynamic";

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
function dayLabel(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function whenLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function Header() {
  return (
    <header className="topbar">
      <span className="wordmark">
        Money<span className="dot money">.</span>
      </span>
      <span className="topbar-right">
        <a className="navlink" href="/">← Home</a>
        <a className="navlink" href="/manage">Manage</a>
        <a className="navlink" href="/experiences">Experiences</a>
        {isAuthConfigured() && <LogoutButton />}
      </span>
    </header>
  );
}

export default async function FinancesPage({
  searchParams,
}: {
  searchParams: Promise<{ horizon?: string }>;
}) {
  const userId = await getCurrentUserId();
  const sp = await searchParams;
  const horizon: ProjectionHorizon =
    sp.horizon === "7d" ? "7d" : sp.horizon === "30d" ? "30d" : "payday";

  const today = localToday();
  let accounts, bills, income, transfers, movements, reconcilableIds, schedules;
  try {
    // Replenish the rolling occurrence window for active schedules (idempotent).
    await replenishOccurrences(userId, today);
    const [acctRows, linkedSnap, billRows, incomeRows, allocRows, transferRows, movementRows, recIds, scheduleRows, schedAllocRows] =
      await Promise.all([
        listAccounts(userId),
        linkedBalanceMap(userId),
        listBills(userId).then(toBillViews),
        listIncome(userId),
        listAllocations(userId),
        listTransfers(userId).then(toTransferViews),
        listMovements(userId, 12).then(toMovementViews),
        getReconcilableAccountIds(userId),
        listSchedules(userId),
        listScheduleAllocations(userId),
      ]);
    accounts = toAccountViews(acctRows, linkedSnap);
    bills = billRows;
    income = toIncomeViews(incomeRows, allocationsByIncome(allocRows));
    transfers = transferRows;
    movements = movementRows;
    reconcilableIds = recIds;
    schedules = toScheduleViews(scheduleRows, scheduleAllocationsBySchedule(schedAllocRows), today);
  } catch (err) {
    // Explicit error state — never fabricate placeholder balances.
    console.error("FinancesPage: load failed.", err);
    return (
      <div className="shell">
        <Header />
        <div className="exp-error">
          <b>Your money workspace is currently unavailable.</b> The database could
          not be reached, so nothing can be shown. This page never displays mock or
          placeholder balances. Please try again later.
        </div>
      </div>
    );
  }

  // Bank connections (Finance 1B.1) — loaded resiliently so a provider/env hiccup
  // never breaks the money workspace; a failure simply shows no connections.
  let connections: ConnectionView[] = [];
  let autoStatus = { configured: false, processorConfigured: false, lastSyncedAt: null as string | null, pending: false, failed: false };
  try {
    connections = await listConnections(userId);
    autoStatus = await getAutoSyncStatus(userId);
  } catch (err) {
    console.error("FinancesPage: connections load failed.", err);
  }

  let pendingMatchCount = 0;
  try {
    pendingMatchCount = await countPendingMatches(userId);
  } catch (err) {
    console.error("FinancesPage: match count load failed.", err);
  }

  let categorySummaryView = { categorized: 0, uncategorized: 0, needsReview: 0 };
  try {
    categorySummaryView = await categorySummary(userId);
  } catch (err) {
    console.error("FinancesPage: category summary load failed.", err);
  }

  const summary = computeCashSummary(accounts);
  const projection = computeProjection({ accounts, bills, income, transfers, horizon, today });
  const accountOptions = accounts
    .filter((a) => a.active)
    .map((a) => ({ id: a.id, name: a.name, linked: a.balanceSource !== "manual" }));
  // Income/transfer destinations are cash accounts (not credit liabilities).
  const cashAccountOptions = accounts
    .filter((a) => a.active && a.type !== "credit")
    .map((a) => ({ id: a.id, name: a.name, linked: a.balanceSource !== "manual" }));
  const hasCredit = summary.creditAccountCount > 0;
  const hasSavings = summary.savingsEmergency !== 0;

  return (
    <div className="shell">
      <Header />

      <div className="mockbanner">
        Your private finances. Every balance below is <b>manually entered</b> — not a
        projection and not synced from a bank. Nothing here is shared, published, or
        spent for you.
      </div>

      {/* 1 — Cash & liabilities (manually entered actual balances) */}
      <section className="tier">
        <div className="tier-head">
          <span className="tier-tick" style={{ background: "var(--good)" }} />
          <span className="tier-name">Cash on hand</span>
          <span className="tier-sub">manually entered actual balances — not projected</span>
        </div>
        <div className="fin-summary">
          <div className="fin-stat">
            <div className="fin-stat-k">Total actual cash</div>
            <div className="fin-stat-v num good">{money(summary.totalActualCash)}</div>
            <div className="fin-stat-note">
              {summary.cashAccountCount} active cash account
              {summary.cashAccountCount === 1 ? "" : "s"} (checking, savings, cash)
            </div>
          </div>
          <div className="fin-stat">
            <div className="fin-stat-k">Spendable actual cash</div>
            <div className="fin-stat-v num">{money(summary.spendableActualCash)}</div>
            <div className="fin-stat-note">excludes accounts you marked not spendable</div>
          </div>
          {hasSavings && (
            <div className="fin-stat">
              <div className="fin-stat-k">Savings &amp; emergency</div>
              <div className="fin-stat-v num">{money(summary.savingsEmergency)}</div>
              <div className="fin-stat-note">held separately, within total cash</div>
            </div>
          )}
          {hasCredit && (
            <div className="fin-stat">
              <div className="fin-stat-k">Credit liabilities</div>
              <div className="fin-stat-v num liab">{money(summary.creditLiabilities)}</div>
              <div className="fin-stat-note">amount owed — never counted as cash</div>
            </div>
          )}
        </div>
        {hasCredit && (
          <div className="fin-netline num">
            Net position (cash − credit owed):{" "}
            <span className={summary.netPosition < 0 ? "liab" : "good"}>
              {money(summary.netPosition)}
            </span>
          </div>
        )}
        {(summary.linkedUnavailableCount ?? 0) > 0 && (
          <div className="fin-warn" role="status">
            ⚠ {summary.linkedUnavailableCount} linked account
            {summary.linkedUnavailableCount === 1 ? " has" : "s have"} no provider balance yet — this
            total is partial. Sync accounts to include them.
          </div>
        )}
        {(summary.linkedStaleCount ?? 0) > 0 && (
          <div className="fin-warn" role="status">
            ⚠ {summary.linkedStaleCount} linked balance
            {summary.linkedStaleCount === 1 ? "" : "s"} may be stale (last known provider balance).
          </div>
        )}
      </section>

      {/* 2 — Accounts */}
      <section className="tier">
        <div className="tier-head">
          <span className="tier-tick" style={{ background: "var(--good)" }} />
          <span className="tier-name">Accounts</span>
          <span className="tier-sub">manual balances you keep up to date</span>
        </div>
        <AccountManager accounts={accounts} reconcilableIds={reconcilableIds} />
      </section>

      {/* 1b — Bank connections (Finance 1B.1: read-only Plaid Sandbox connect) */}
      <section className="tier">
        <div className="tier-head">
          <span className="tier-tick" style={{ background: "var(--explore)" }} />
          <span className="tier-name">Bank connections</span>
          <span className="tier-sub">read-only · Plaid Sandbox · fake test data</span>
        </div>
        <ConnectionManager initialConnections={connections} />
      </section>

      {/* 1b.3a — Imported activity (Plaid Sandbox transactions, read-only evidence) */}
      <section className="tier">
        <div className="tier-head">
          <span className="tier-tick" style={{ background: "var(--explore)" }} />
          <span className="tier-name">Imported activity</span>
          <span className="tier-sub">bank evidence · read-only · separate from Xanther activity</span>
        </div>
        <ImportedActivity connections={connections} autoStatus={autoStatus} />
      </section>

      {/* 1b.5a — Categorize transactions (descriptive metadata + owner merchant rules) */}
      <section className="tier">
        <div className="tier-head">
          <span className="tier-tick" style={{ background: "var(--explore)" }} />
          <span className="tier-name">Categorize transactions</span>
          <span className="tier-sub">descriptive only · you decide · {categorySummaryView.categorized} categorized · {categorySummaryView.uncategorized} uncategorized · {categorySummaryView.needsReview} to review</span>
        </div>
        <Categorize initialNeedsReview={categorySummaryView.uncategorized + categorySummaryView.needsReview} />
      </section>

      {/* 1b.5b — Spending insights (read-only deterministic intelligence) */}
      <section className="tier">
        <div className="tier-head">
          <span className="tier-tick" style={{ background: "var(--explore)" }} />
          <span className="tier-name">Spending insights</span>
          <span className="tier-sub">read-only · deterministic · transfers &amp; income excluded</span>
        </div>
        <SpendingInsights />
      </section>

      {/* 1c.0a — Credit & financial health (manual, read-only educational guidance) */}
      <section className="tier">
        <div className="tier-head">
          <span className="tier-tick" style={{ background: "var(--explore)" }} />
          <span className="tier-name">Credit &amp; financial health</span>
          <span className="tier-sub">manual · read-only · no bureau connection · educational only</span>
        </div>
        <CreditHealth />
      </section>

      {/* 1b.4a — Suggested matches (deterministic, suggestion-only, owner-confirmed) */}
      <section className="tier">
        <div className="tier-head">
          <span className="tier-tick" style={{ background: "var(--explore)" }} />
          <span className="tier-name">Suggested matches</span>
          <span className="tier-sub">deterministic · suggestion-only · you confirm</span>
        </div>
        <SuggestedMatches initialPendingCount={pendingMatchCount} />
      </section>

      {/* 2b — Projected balances (deterministic forecast, separate from actual) */}
      <section className="tier">
        <div className="tier-head">
          <span className="tier-tick" style={{ background: "var(--explore)" }} />
          <span className="tier-name">Projected balances</span>
          <span className="tier-sub">
            actual + scheduled inflows − scheduled outflows · a forecast, not a current balance
          </span>
        </div>

        <div className="fin-horizon">
          <span className="sub">Horizon:</span>
          {HORIZONS.map((h) => (
            <a key={h.key} href={`/finances?horizon=${h.key}`}
              className={`fin-horizon-btn${horizon === h.key ? " on" : ""}`}>
              {h.label}
            </a>
          ))}
          <span className="sub">
            · {projection.horizonLabel} (through {dayLabel(projection.horizonDate)})
          </span>
        </div>

        <div className="fin-summary">
          <div className="fin-stat">
            <div className="fin-stat-k">Total actual cash</div>
            <div className="fin-stat-v num good">{money(projection.totals.totalActualCash)}</div>
            <div className="fin-stat-note">manually entered, now</div>
          </div>
          <div className="fin-stat">
            <div className="fin-stat-k">Total projected cash</div>
            <div className="fin-stat-v num">{money(projection.totals.totalProjectedCash)}</div>
            <div className="fin-stat-note">forecast for {projection.horizonLabel.toLowerCase()} — not available-now</div>
          </div>
          <div className="fin-stat">
            <div className="fin-stat-k">Spendable projected</div>
            <div className="fin-stat-v num">{money(projection.totals.spendableProjectedCash)}</div>
            <div className="fin-stat-note">spendable accounts only</div>
          </div>
          {hasCredit && (
            <div className="fin-stat">
              <div className="fin-stat-k">Credit liabilities</div>
              <div className="fin-stat-v num liab">{money(projection.totals.creditLiabilities)}</div>
              <div className="fin-stat-note">kept separate — never cash</div>
            </div>
          )}
        </div>

        {projection.warnings.length > 0 && (
          <ul className="fin-warnings">
            {projection.warnings.map((w, i) => (
              <li key={i} className={`fin-warning ${w.code === "shortfall" ? "act" : "aware"}`}>
                ⚠ {w.message}
              </li>
            ))}
          </ul>
        )}

        <div className="fin-acct-grid">
          {projection.accounts.filter((p) => p.isCash || p.isLiability).map((p) => (
            <div className={`fin-acct${p.belowZero ? " shortfall" : ""}`} key={p.accountId}>
              <div className="fin-acct-top">
                <div>
                  <div className="fin-acct-name">{p.name}</div>
                  <div className="fin-acct-meta">
                    actual <span className="num">{money(p.actualBalance)}</span>
                  </div>
                </div>
                <div className={`fin-acct-bal num${p.belowZero ? " liab" : ""}`}>
                  {money(p.projectedBalance)}
                </div>
              </div>
              <div className="fin-acct-tags">
                <span className="fin-tag muted">Projected ({HORIZONS.find((h) => h.key === horizon)!.label})</span>
                {p.scheduledInflows > 0 && <span className="fin-tag good">+{money(p.scheduledInflows)} in</span>}
                {p.scheduledOutflows > 0 && <span className="fin-tag liab">−{money(p.scheduledOutflows)} out</span>}
                {p.belowZero && <span className="fin-tag liab">Projected shortfall</span>}
              </div>
            </div>
          ))}
        </div>

        {/* Forecast timeline */}
        <div className="fin-bill-grouphead" style={{ marginTop: 12 }}>Forecast timeline</div>
        {projection.items.length === 0 ? (
          <div className="empty">No scheduled items within this horizon.</div>
        ) : (
          <div className="fin-activity">
            {projection.items.map((it: ForecastItem, i) => (
              <div className="fin-activity-row" key={i}>
                <div>
                  <div className="main">{FORECAST_LABEL[it.kind] ?? it.kind}: {it.label.replace(/^(Bill|Income|Transfer[^:]*): /, "")}</div>
                  <div className="sub">
                    {it.accountName ?? "unassigned"} · {dayLabel(it.date)}
                    {it.resultingBalance != null ? ` · → ${money(it.resultingBalance)} projected` : ""}
                  </div>
                </div>
                <span className={`num ${it.amount >= 0 ? "good" : "liab"}`}>
                  {it.amount >= 0 ? "+" : ""}{money(it.amount)}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Unassigned + unsupported items (never guessed into an account) */}
        {(projection.unassignedBills.length > 0 || projection.unassignedIncome.length > 0 || projection.linkedSkipped.length > 0) && (
          <div className="fin-unassigned">
            <div className="fin-bill-grouphead unassigned" style={{ marginTop: 12 }}>Not included in projections</div>
            {projection.unassignedBills.map((b) => (
              <div className="sub" key={`ub${b.id}`}>• Unassigned bill: {b.name} ({money(b.amount)}, due {dayLabel(b.dueDate)}) — no payment account.</div>
            ))}
            {projection.unassignedIncome.map((i) => (
              <div className="sub" key={`ui${i.id}`}>• Income with no destination: {i.source} ({money(i.amount)}, {dayLabel(i.payDate)}).</div>
            ))}
            {projection.linkedSkipped.map((l, i) => (
              <div className="sub" key={`ls${i}`}>• {l.label} — awaiting future bank sync.</div>
            ))}
          </div>
        )}
      </section>

      {/* 3 — Bills, grouped by the account that pays them */}
      <section className="tier">
        <div className="tier-head">
          <span className="tier-tick" style={{ background: "var(--aware)" }} />
          <span className="tier-name">Bills</span>
          <span className="tier-sub">grouped by the account they’re paid from</span>
        </div>
        <BillManager bills={bills} accounts={accountOptions} />
      </section>

      {/* 4a — Recurring income schedules (estimated paychecks) */}
      <section className="tier">
        <div className="tier-head">
          <span className="tier-tick" style={{ background: "var(--good)" }} />
          <span className="tier-name">Recurring income</span>
          <span className="tier-sub">estimated paydays — amounts confirmed only when received</span>
        </div>
        <ScheduleManager schedules={schedules} accounts={cashAccountOptions} />
      </section>

      {/* 4b — Income occurrences (single destination or split), received into accounts */}
      <section className="tier">
        <div className="tier-head">
          <span className="tier-tick" style={{ background: "var(--good)" }} />
          <span className="tier-name">Income</span>
          <span className="tier-sub">upcoming estimates + confirmed receipts (with variance)</span>
        </div>
        <IncomeManager income={income} accounts={cashAccountOptions} today={today} />
      </section>

      {/* 5 — Transfers between owned accounts */}
      <section className="tier">
        <div className="tier-head">
          <span className="tier-tick" style={{ background: "var(--good)" }} />
          <span className="tier-name">Transfers</span>
          <span className="tier-sub">move money between your accounts — never income or spending</span>
        </div>
        <TransferManager transfers={transfers} accounts={cashAccountOptions} />
      </section>

      {/* 6 — Recent activity: the append-only account-movements ledger */}
      <section className="tier">
        <div className="tier-head">
          <span className="tier-tick" style={{ background: "var(--good)" }} />
          <span className="tier-name">Recent activity</span>
          <span className="tier-sub">recorded payments, income receipts &amp; transfers</span>
        </div>
        {movements.length === 0 ? (
          <div className="empty">No recorded activity yet.</div>
        ) : (
          <div className="fin-activity">
            {movements.map((m) => {
              const positive = m.amount >= 0;
              return (
                <div className="fin-activity-row" key={m.id}>
                  <div>
                    <div className="main">
                      {MOVEMENT_LABEL[m.kind] ?? m.kind}
                      {movementContext(m)}
                    </div>
                    <div className="sub">
                      {m.accountName ?? `Account #${m.accountId}`} · {whenLabel(m.occurredAt)}
                    </div>
                  </div>
                  <span className={`num ${positive ? "good" : "liab"}`}>
                    {positive ? "+" : ""}
                    {money(m.amount)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
