/* /finances — the dedicated money workspace (Finance 1A.1 + 1A.3A + 1A.2).
 *
 * Account-aware manual finance: accounts with truthful cash/liability totals,
 * bills grouped by paying account, income (single or split) you receive into
 * your accounts, transfers between owned accounts, and an append-only activity
 * ledger. Every figure comes from manually entered actual balances. This page
 * never presents a projected number as if it were a current or spendable-now
 * balance — account-aware projection arrives in a later Finance build. */

import { getCurrentUserId } from "@/lib/auth";
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
} from "@/lib/services/finances";
import { listTransfers, toTransferViews } from "@/lib/services/transfers";
import { isAuthConfigured } from "@/lib/session";
import { LogoutButton } from "@/components/logout-button";
import { AccountManager } from "@/components/finances/account-manager";
import { BillManager } from "@/components/finances/bill-manager";
import { IncomeManager } from "@/components/finances/income-manager";
import { TransferManager } from "@/components/finances/transfer-manager";
import type { MovementView } from "@/lib/types";

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

export default async function FinancesPage() {
  const userId = await getCurrentUserId();

  let accounts, bills, income, transfers, movements;
  try {
    const [accts, billRows, incomeRows, allocRows, transferRows, movementRows] = await Promise.all([
      listAccounts(userId).then(toAccountViews),
      listBills(userId).then(toBillViews),
      listIncome(userId),
      listAllocations(userId),
      listTransfers(userId).then(toTransferViews),
      listMovements(userId, 12).then(toMovementViews),
    ]);
    accounts = accts;
    bills = billRows;
    income = toIncomeViews(incomeRows, allocationsByIncome(allocRows));
    transfers = transferRows;
    movements = movementRows;
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

  const summary = computeCashSummary(accounts);
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
      </section>

      {/* 2 — Accounts */}
      <section className="tier">
        <div className="tier-head">
          <span className="tier-tick" style={{ background: "var(--good)" }} />
          <span className="tier-name">Accounts</span>
          <span className="tier-sub">manual balances you keep up to date</span>
        </div>
        <AccountManager accounts={accounts} />
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

      {/* 4 — Income (single destination or split), received into your accounts */}
      <section className="tier">
        <div className="tier-head">
          <span className="tier-tick" style={{ background: "var(--good)" }} />
          <span className="tier-name">Income</span>
          <span className="tier-sub">assign to one account or split; receive to credit balances</span>
        </div>
        <IncomeManager income={income} accounts={cashAccountOptions} />
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
