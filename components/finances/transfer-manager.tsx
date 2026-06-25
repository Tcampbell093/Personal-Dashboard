"use client";

/* Transfer management island for /finances (Finance 1A.2).
 *
 * Schedule a transfer between two owned accounts, complete it (which moves both
 * manual balances and records paired movements), or reverse a completed one.
 * A scheduled transfer changes no balance; an internal transfer is never income
 * or spending and never changes total owned cash. */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TransferView } from "@/lib/types";

type AccountOption = { id: number; name: string; linked: boolean };

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
function shortDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso.slice(0, 10) + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
async function readError(res: Response): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  return data?.error ?? `Request failed (${res.status}).`;
}

const STATUS_TAG: Record<string, string> = {
  scheduled: "Scheduled",
  completed: "Completed",
  reversed: "Reversed",
  cancelled: "Cancelled",
};

export function TransferManager({
  transfers,
  accounts,
}: {
  transfers: TransferView[];
  accounts: AccountOption[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const linkedIds = new Set(accounts.filter((a) => a.linked).map((a) => a.id));

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

  return (
    <div className="fin-transfers">
      <AddTransfer accounts={accounts} pending={pending} onAdd={(body) =>
        mutate("/api/finances/transfers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      } />

      {transfers.length === 0 && <div className="empty">No transfers yet.</div>}

      {transfers.map((t) => (
        <div className="fin-bill-row" key={t.id}>
          <div>
            <div className="main">
              {t.fromName ?? `#${t.fromAccountId}`} <span className="fin-arrow">→</span>{" "}
              {t.toName ?? `#${t.toAccountId}`}
            </div>
            <div className="sub">
              <span className={`fin-tag ${t.status === "completed" ? "good" : t.status === "reversed" ? "muted" : ""}`}>
                {STATUS_TAG[t.status] ?? t.status}
              </span>{" "}
              {t.scheduledDate ? `· ${shortDate(t.scheduledDate)} ` : ""}
              {t.note ? `· ${t.note}` : ""}
            </div>
          </div>
          <div className="fin-bill-right">
            <span className="num">{money(t.amount)}</span>
            {t.status === "scheduled" && (
              linkedIds.has(t.fromAccountId) || linkedIds.has(t.toAccountId) ? (
                <span className="sub unassigned-text" title="Linked accounts require bank-sync confirmation">
                  Linked — bank-sync only
                </span>
              ) : (
                <button className="linkbtn" disabled={pending}
                  onClick={() => mutate(`/api/finances/transfers/${t.id}/complete`, { method: "POST" })}>
                  Complete
                </button>
              )
            )}
            {t.status === "completed" && (
              <button className="linkbtn" disabled={pending}
                onClick={() => mutate(`/api/finances/transfers/${t.id}/reverse`, { method: "POST" })}
                title="Undo this transfer and restore both balances">
                Reverse
              </button>
            )}
            {t.status !== "completed" && (
              <button className="linkbtn danger" disabled={pending}
                onClick={() => mutate(`/api/finances/transfers/${t.id}`, { method: "DELETE" })}>
                Delete
              </button>
            )}
          </div>
        </div>
      ))}

      <div className="fin-form-note">
        A scheduled transfer changes no balance. Completing it moves money between
        your accounts — it is never income or spending and never changes your total
        cash. Only transfers between <b>manual</b> accounts can be completed for now;
        linked accounts need bank-sync confirmation.
      </div>
      {error && <div className="taskadd-error">{error}</div>}
    </div>
  );
}

function AddTransfer({ accounts, pending, onAdd }: {
  accounts: AccountOption[];
  pending: boolean;
  onAdd: (b: Record<string, unknown>) => Promise<boolean>;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");

  return (
    <form className="fin-bill-add" onSubmit={async (e) => {
      e.preventDefault();
      if (!from || !to || !amount) return;
      if (await onAdd({
        fromAccountId: Number(from), toAccountId: Number(to),
        amount: Number(amount), scheduledDate: date || null, note: note || null,
      })) { setFrom(""); setTo(""); setAmount(""); setDate(""); setNote(""); }
    }}>
      <select className="taskadd-field" value={from} onChange={(e) => setFrom(e.target.value)} disabled={pending} title="From account">
        <option value="">From…</option>
        {accounts.map((a) => (<option key={a.id} value={a.id}>{a.name}{a.linked ? " (linked)" : ""}</option>))}
      </select>
      <select className="taskadd-field" value={to} onChange={(e) => setTo(e.target.value)} disabled={pending} title="To account">
        <option value="">To…</option>
        {accounts.map((a) => (<option key={a.id} value={a.id}>{a.name}{a.linked ? " (linked)" : ""}</option>))}
      </select>
      <input className="taskadd-field" type="number" step="0.01" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={pending} />
      <input className="taskadd-field" type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={pending} title="Scheduled date" />
      <input className="taskadd-field" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} disabled={pending} />
      <button className="btn" type="submit" disabled={pending || !from || !to || !amount}>Schedule transfer</button>
    </form>
  );
}
