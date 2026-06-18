"use client";

/* Finance management island. Renders three sub-sections — accounts, bills,
 * income — each with a quick-add form and a list. Mutations go through
 * /api/finances/* then router.refresh() recomputes the outlook server-side. */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AccountView, BillView, IncomeView } from "@/lib/types";

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
function shortDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}
async function readError(res: Response): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  return data?.error ?? `Request failed (${res.status}).`;
}

export function FinanceManager({
  accounts,
  bills,
  income,
}: {
  accounts: AccountView[];
  bills: BillView[];
  income: IncomeView[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // shared mutation helper
  async function mutate(url: string, init: RequestInit) {
    setError(null);
    const res = await fetch(url, init);
    if (!res.ok) {
      setError(await readError(res));
      return false;
    }
    startTransition(() => router.refresh());
    return true;
  }

  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return (
    <div className="finance-mgr">
      <div className="finance-cols">
        <AccountsBlock
          accounts={accounts}
          pending={pending}
          onAdd={(name, balance) =>
            mutate("/api/finances/accounts", json({ name, currentBalance: balance }))
          }
          onDelete={(id) =>
            mutate(`/api/finances/accounts/${id}`, { method: "DELETE" })
          }
        />
        <BillsBlock
          bills={bills}
          pending={pending}
          onAdd={(name, amount, dueDate) =>
            mutate(
              "/api/finances/bills",
              json({ name, expectedAmount: amount, dueDate: dueDate || undefined }),
            )
          }
          onPay={(id) =>
            mutate(`/api/finances/bills/${id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: "paid" }),
            })
          }
          onDelete={(id) => mutate(`/api/finances/bills/${id}`, { method: "DELETE" })}
        />
        <IncomeBlock
          income={income}
          pending={pending}
          onAdd={(source, amount, payDate) =>
            mutate(
              "/api/finances/income",
              json({ source, expectedAmount: amount, payDate }),
            )
          }
          onDelete={(id) =>
            mutate(`/api/finances/income/${id}`, { method: "DELETE" })
          }
        />
      </div>
      {error && <div className="taskadd-error">{error}</div>}
    </div>
  );
}

function AccountsBlock({
  accounts,
  pending,
  onAdd,
  onDelete,
}: {
  accounts: AccountView[];
  pending: boolean;
  onAdd: (name: string, balance: string) => void;
  onDelete: (id: number) => void;
}) {
  const [name, setName] = useState("");
  const [balance, setBalance] = useState("");
  const total = accounts.reduce((s, a) => s + a.currentBalance, 0);

  return (
    <div className="finance-block">
      <div className="finance-head">
        Accounts <span className="num">{money(total)}</span>
      </div>
      <form
        className="taskadd"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          onAdd(name.trim(), balance || "0");
          setName("");
          setBalance("");
        }}
      >
        <input
          className="taskadd-title"
          placeholder="Account name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={pending}
        />
        <input
          className="taskadd-field"
          type="number"
          step="0.01"
          placeholder="Balance"
          value={balance}
          onChange={(e) => setBalance(e.target.value)}
          disabled={pending}
        />
        <button className="btn" type="submit" disabled={pending || !name.trim()}>
          Add
        </button>
      </form>
      {accounts.length === 0 && <div className="empty">No accounts yet.</div>}
      {accounts.map((a) => (
        <div className="row" key={a.id}>
          <div className="main">{a.name}</div>
          <div className="right">
            <span className="num">{money(a.currentBalance)}</span>
            <div className="taskactions">
              <button
                className="iconbtn danger"
                onClick={() => onDelete(a.id)}
                disabled={pending}
                title="Delete account"
              >
                ✕
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function BillsBlock({
  bills,
  pending,
  onAdd,
  onPay,
  onDelete,
}: {
  bills: BillView[];
  pending: boolean;
  onAdd: (name: string, amount: string, dueDate: string) => void;
  onPay: (id: number) => void;
  onDelete: (id: number) => void;
}) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState("");

  return (
    <div className="finance-block">
      <div className="finance-head">Bills</div>
      <form
        className="taskadd"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim() || !amount) return;
          onAdd(name.trim(), amount, dueDate);
          setName("");
          setAmount("");
          setDueDate("");
        }}
      >
        <input
          className="taskadd-title"
          placeholder="Bill name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={pending}
        />
        <input
          className="taskadd-field"
          type="number"
          step="0.01"
          placeholder="Amount"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={pending}
        />
        <input
          className="taskadd-field"
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          disabled={pending}
        />
        <button className="btn" type="submit" disabled={pending || !name.trim() || !amount}>
          Add
        </button>
      </form>
      {bills.length === 0 && <div className="empty">No bills yet.</div>}
      {bills.map((b) => (
        <div className="row" key={b.id}>
          <div>
            <div className="main">{b.name}</div>
            <div className="sub">
              due {shortDate(b.dueDate)}
              {b.status === "paid" ? " · paid" : ""}
            </div>
          </div>
          <div className="right">
            <span className="num">{money(b.expectedAmount)}</span>
            <div className="taskactions">
              {b.status !== "paid" && (
                <button
                  className="iconbtn"
                  onClick={() => onPay(b.id)}
                  disabled={pending}
                  title="Mark paid"
                >
                  ✓
                </button>
              )}
              <button
                className="iconbtn danger"
                onClick={() => onDelete(b.id)}
                disabled={pending}
                title="Delete bill"
              >
                ✕
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function IncomeBlock({
  income,
  pending,
  onAdd,
  onDelete,
}: {
  income: IncomeView[];
  pending: boolean;
  onAdd: (source: string, amount: string, payDate: string) => void;
  onDelete: (id: number) => void;
}) {
  const [source, setSource] = useState("");
  const [amount, setAmount] = useState("");
  const [payDate, setPayDate] = useState("");

  return (
    <div className="finance-block">
      <div className="finance-head">Income</div>
      <form
        className="taskadd"
        onSubmit={(e) => {
          e.preventDefault();
          if (!source.trim() || !amount || !payDate) return;
          onAdd(source.trim(), amount, payDate);
          setSource("");
          setAmount("");
          setPayDate("");
        }}
      >
        <input
          className="taskadd-title"
          placeholder="Source"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          disabled={pending}
        />
        <input
          className="taskadd-field"
          type="number"
          step="0.01"
          placeholder="Amount"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={pending}
        />
        <input
          className="taskadd-field"
          type="date"
          value={payDate}
          onChange={(e) => setPayDate(e.target.value)}
          disabled={pending}
        />
        <button
          className="btn"
          type="submit"
          disabled={pending || !source.trim() || !amount || !payDate}
        >
          Add
        </button>
      </form>
      {income.length === 0 && <div className="empty">No income yet.</div>}
      {income.map((i) => (
        <div className="row" key={i.id}>
          <div>
            <div className="main">{i.source}</div>
            <div className="sub">
              {shortDate(i.payDate)}
              {i.isPayday ? " · payday" : ""}
            </div>
          </div>
          <div className="right">
            <span className="num">{money(i.expectedAmount)}</span>
            <div className="taskactions">
              <button
                className="iconbtn danger"
                onClick={() => onDelete(i.id)}
                disabled={pending}
                title="Delete income"
              >
                ✕
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
