/* /finances — the dedicated money workspace (Finance 1A.1).
 *
 * Account-aware manual finance: multiple accounts with truthful cash and
 * liability totals, plus bills grouped by the account that pays them. Every
 * figure here comes from manually entered actual balances. This page never
 * presents a projected number as if it were a current or spendable-now balance
 * — account-aware projection arrives in Finance 1A.3. */

import { getCurrentUserId } from "@/lib/auth";
import {
  listAccounts,
  toAccountViews,
  listBills,
  toBillViews,
  computeCashSummary,
  listMovements,
  toMovementViews,
} from "@/lib/services/finances";
import { isAuthConfigured } from "@/lib/session";
import { LogoutButton } from "@/components/logout-button";
import { AccountManager } from "@/components/finances/account-manager";
import { BillManager } from "@/components/finances/bill-manager";

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

  let accounts, bills, movements;
  try {
    [accounts, bills, movements] = await Promise.all([
      listAccounts(userId).then(toAccountViews),
      listBills(userId).then(toBillViews),
      listMovements(userId, 8).then(toMovementViews),
    ]);
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
    .map((a) => ({ id: a.id, name: a.name }));
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

      {/* 4 — Recent activity: the manual bill-payment ledger (append-only) */}
      <section className="tier">
        <div className="tier-head">
          <span className="tier-tick" style={{ background: "var(--good)" }} />
          <span className="tier-name">Recent activity</span>
          <span className="tier-sub">recorded bill payments &amp; reversals</span>
        </div>
        {movements.length === 0 ? (
          <div className="empty">No recorded payments yet.</div>
        ) : (
          <div className="fin-activity">
            {movements.map((m) => {
              const reversal = m.kind === "bill_payment_reversal";
              return (
                <div className="fin-activity-row" key={m.id}>
                  <div>
                    <div className="main">
                      {reversal ? "Reversed payment" : "Bill payment"}
                      {m.billName ? ` · ${m.billName}` : ""}
                    </div>
                    <div className="sub">
                      {m.accountName ?? `Account #${m.accountId}`} · {whenLabel(m.occurredAt)}
                    </div>
                  </div>
                  <span className={`num ${reversal ? "good" : "liab"}`}>
                    {reversal ? "+" : ""}
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
