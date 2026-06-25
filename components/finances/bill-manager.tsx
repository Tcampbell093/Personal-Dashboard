"use client";

/* Bill management island for /finances (Finance 1A.1 + 1A.3A).
 *
 * Bills are grouped by the account they are paid from; bills with no account
 * appear under "Payment account not assigned" (never auto-guessed). Supports
 * add, reassign payment account, pay (recording the confirmed actual amount and
 * the account used — or external/cash), reverse a payment, and delete. Paying
 * from a manual account deducts that account's balance and records a ledger
 * movement; reversing credits it back. */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { BillView } from "@/lib/types";

type AccountOption = { id: number; name: string };

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
function shortDate(iso: string | null): string {
  if (!iso) return "no due date";
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}
async function readError(res: Response): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  return data?.error ?? `Request failed (${res.status}).`;
}

const UNASSIGNED = "Payment account not assigned";

export function BillManager({
  bills,
  accounts,
}: {
  bills: BillView[];
  accounts: AccountOption[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [payingId, setPayingId] = useState<number | null>(null);

  const nameOf = (id: number | null) =>
    id == null ? null : accounts.find((a) => a.id === id)?.name ?? `Account #${id}`;

  async function mutate(url: string, init: RequestInit): Promise<boolean> {
    setError(null);
    const res = await fetch(url, init);
    if (!res.ok) {
      setError(await readError(res));
      return false;
    }
    startTransition(() => router.refresh());
    return true;
  }

  // Group bills by source account (null = unassigned), unassigned last.
  const groups = new Map<number | null, BillView[]>();
  for (const b of bills) {
    const k = b.sourceAccountId ?? null;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(b);
  }
  const orderedKeys = [...groups.keys()].sort((a, z) => {
    if (a === null) return 1;
    if (z === null) return -1;
    return (nameOf(a) ?? "").localeCompare(nameOf(z) ?? "");
  });

  return (
    <div className="fin-bills">
      <AddBill
        accounts={accounts}
        pending={pending}
        onAdd={(body) =>
          mutate("/api/finances/bills", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        }
      />

      {bills.length === 0 && <div className="empty">No bills yet.</div>}

      {orderedKeys.map((key) => (
        <div className="fin-bill-group" key={key ?? "unassigned"}>
          <div className={`fin-bill-grouphead${key === null ? " unassigned" : ""}`}>
            {key === null ? UNASSIGNED : nameOf(key)}
          </div>
          {groups.get(key)!.map((b) => {
            const paid = b.status === "paid";
            const paidFrom = nameOf(b.paidAccountId);
            return (
              <div className="fin-bill-row" key={b.id}>
                <div>
                  <div className="main">{b.name}</div>
                  <div className="sub">
                    {paid ? (
                      <span className="fin-tag good">
                        Paid
                        {b.actualAmount != null ? ` · ${money(b.actualAmount)}` : ""}
                        {" · "}
                        {paidFrom ? `from ${paidFrom}` : "external / cash"}
                      </span>
                    ) : (
                      <span className="fin-bill-due">due {shortDate(b.dueDate)}</span>
                    )}
                  </div>
                </div>
                <div className="fin-bill-right">
                  <span className="num">{money(b.expectedAmount)}</span>
                  {!paid && payingId !== b.id && (
                    <button
                      className="linkbtn"
                      onClick={() => setPayingId(b.id)}
                      disabled={pending}
                    >
                      Pay
                    </button>
                  )}
                  {paid && (
                    <button
                      className="linkbtn"
                      onClick={() =>
                        mutate(`/api/finances/bills/${b.id}/reverse`, { method: "POST" })
                      }
                      disabled={pending}
                      title="Undo this payment and restore the balance"
                    >
                      Reverse
                    </button>
                  )}
                  <button
                    className="linkbtn danger"
                    onClick={() =>
                      mutate(`/api/finances/bills/${b.id}`, { method: "DELETE" })
                    }
                    disabled={pending}
                  >
                    Delete
                  </button>
                </div>
                {payingId === b.id && (
                  <PayForm
                    accounts={accounts}
                    defaultAccountId={b.sourceAccountId}
                    defaultAmount={b.expectedAmount}
                    pending={pending}
                    onCancel={() => setPayingId(null)}
                    onConfirm={async (body) => {
                      const okk = await mutate(`/api/finances/bills/${b.id}/pay`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(body),
                      });
                      if (okk) setPayingId(null);
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      ))}

      <div className="fin-form-note">
        Paying from a manual account deducts that account’s balance and records a
        movement. Reversing restores the balance. External/cash payments change no
        balance.
      </div>
      {error && <div className="taskadd-error">{error}</div>}
    </div>
  );
}

function PayForm({
  accounts,
  defaultAccountId,
  defaultAmount,
  pending,
  onConfirm,
  onCancel,
}: {
  accounts: AccountOption[];
  defaultAccountId: number | null;
  defaultAmount: number;
  pending: boolean;
  onConfirm: (body: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  // "" = external/cash; otherwise an account id.
  const [sel, setSel] = useState<string>(
    defaultAccountId != null ? String(defaultAccountId) : "",
  );
  const [amount, setAmount] = useState<string>(defaultAmount ? String(defaultAmount) : "");

  return (
    <div className="fin-pay">
      <label className="fin-field">
        <span>Actual amount</span>
        <input
          type="number"
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          disabled={pending}
        />
      </label>
      <label className="fin-field">
        <span>Pay from</span>
        <select value={sel} onChange={(e) => setSel(e.target.value)} disabled={pending}>
          <option value="">External / cash (no account)</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <button
        className="btn"
        onClick={() =>
          onConfirm(
            sel === ""
              ? { external: true, actualAmount: amount === "" ? undefined : Number(amount) }
              : { paidAccountId: Number(sel), actualAmount: amount === "" ? undefined : Number(amount) },
          )
        }
        disabled={pending}
      >
        Confirm payment
      </button>
      <button className="linkbtn" onClick={onCancel} disabled={pending}>
        Cancel
      </button>
    </div>
  );
}

function AddBill({
  accounts,
  pending,
  onAdd,
}: {
  accounts: AccountOption[];
  pending: boolean;
  onAdd: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [account, setAccount] = useState(""); // "" = explicitly unassigned

  return (
    <form
      className="fin-bill-add"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim() || !amount) return;
        const ok = await onAdd({
          name: name.trim(),
          expectedAmount: Number(amount),
          dueDate: dueDate || null,
          sourceAccountId: account === "" ? null : Number(account),
        });
        if (ok) {
          setName("");
          setAmount("");
          setDueDate("");
          setAccount("");
        }
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
      <select
        className="taskadd-field"
        value={account}
        onChange={(e) => setAccount(e.target.value)}
        disabled={pending}
        title="Payment account"
      >
        <option value="">Unassigned</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      <button className="btn" type="submit" disabled={pending || !name.trim() || !amount}>
        Add bill
      </button>
    </form>
  );
}
