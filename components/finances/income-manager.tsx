"use client";

/* Income management island for /finances (Finance 1A.2).
 *
 * Add scheduled income, assign it to one account or split it across several
 * (fixed / percent-of-remaining / remainder), preview the split in dollars,
 * confirm the actual gross at receipt (which credits each manual destination via
 * the ledger), and undo a receipt. Scheduled income changes no balance. */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { IncomeView } from "@/lib/types";
import {
  computeAllocationShares,
  type AllocationInput,
} from "@/lib/finance-allocations";

type AccountOption = { id: number; name: string; linked: boolean };

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
function shortDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso.slice(0, 10) + "T00:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}
async function readError(res: Response): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  return data?.error ?? `Request failed (${res.status}).`;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function IncomeManager({
  income,
  accounts,
}: {
  income: IncomeView[];
  accounts: AccountOption[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [receivingId, setReceivingId] = useState<number | null>(null);

  const nameOf = (id: number | null) =>
    id == null ? null : accounts.find((a) => a.id === id)?.name ?? `Account #${id}`;
  const linkedIds = new Set(accounts.filter((a) => a.linked).map((a) => a.id));
  function involvesLinked(i: IncomeView): boolean {
    const ids = i.allocations.length
      ? i.allocations.map((a) => a.accountId)
      : i.destinationAccountId != null
        ? [i.destinationAccountId]
        : [];
    return ids.some((id) => linkedIds.has(id));
  }

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

  const scheduled = income.filter((i) => i.status !== "received");
  const received = income.filter((i) => i.status === "received");

  function destinationSummary(i: IncomeView): string {
    if (i.allocations.length) return `Split across ${i.allocations.length} accounts`;
    if (i.destinationAccountId != null) return `To ${nameOf(i.destinationAccountId)}`;
    return "Destination not assigned";
  }

  return (
    <div className="fin-income">
      <AddIncome pending={pending} onAdd={(body) =>
        mutate("/api/finances/income", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      } />

      {income.length === 0 && <div className="empty">No income yet.</div>}

      {scheduled.length > 0 && <div className="fin-bill-grouphead">Scheduled</div>}
      {scheduled.map((i) => (
        <div className="fin-income-row" key={i.id}>
          <div className="fin-income-head">
            <div>
              <div className="main">{i.source}</div>
              <div className="sub">
                {money(i.expectedAmount)} · {shortDate(i.payDate)} ·{" "}
                <span className={i.allocations.length || i.destinationAccountId != null ? "" : "unassigned-text"}>
                  {destinationSummary(i)}
                </span>
              </div>
            </div>
            <div className="fin-bill-right">
              <button className="linkbtn" disabled={pending}
                onClick={() => { setEditingId(editingId === i.id ? null : i.id); setReceivingId(null); }}>
                {editingId === i.id ? "Close" : "Destination"}
              </button>
              <button className="linkbtn" disabled={pending}
                onClick={() => { setReceivingId(receivingId === i.id ? null : i.id); setEditingId(null); }}>
                Receive
              </button>
              <button className="linkbtn danger" disabled={pending}
                onClick={() => mutate(`/api/finances/income/${i.id}`, { method: "DELETE" })}>
                Delete
              </button>
            </div>
          </div>
          {editingId === i.id && (
            <DestinationEditor income={i} accounts={accounts} pending={pending}
              onSingle={async (accountId) => {
                if (await mutate(`/api/finances/income/${i.id}`, {
                  method: "PATCH", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ destinationAccountId: accountId }),
                })) setEditingId(null);
              }}
              onSplit={async (allocations) => {
                if (await mutate(`/api/finances/income/${i.id}`, {
                  method: "PATCH", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ allocations }),
                })) setEditingId(null);
              }} />
          )}
          {receivingId === i.id && (
            <ReceiveForm income={i} pending={pending} linkedBlocked={involvesLinked(i)}
              onConfirm={async (actualAmount, receivedDate) => {
                if (await mutate(`/api/finances/income/${i.id}/receive`, {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ actualAmount, receivedDate }),
                })) setReceivingId(null);
              }} />
          )}
        </div>
      ))}

      {received.length > 0 && <div className="fin-bill-grouphead" style={{ marginTop: 12 }}>Received</div>}
      {received.map((i) => (
        <div className="fin-income-row" key={i.id}>
          <div className="fin-income-head">
            <div>
              <div className="main">{i.source}</div>
              <div className="sub">
                <span className="fin-tag good">Received</span>{" "}
                {money(i.actualAmount ?? i.expectedAmount)} · {shortDate(i.receivedAt)} ·{" "}
                {destinationSummary(i)}
              </div>
            </div>
            <div className="fin-bill-right">
              <button className="linkbtn" disabled={pending}
                onClick={() => mutate(`/api/finances/income/${i.id}/reverse`, { method: "POST" })}
                title="Undo this receipt and restore balances">
                Undo receipt
              </button>
            </div>
          </div>
        </div>
      ))}

      <div className="fin-form-note">
        Scheduled income does not change any balance. Receiving credits each manual
        destination and records a movement. Income to a <b>linked</b> account can’t be
        confirmed manually yet — use a manual account for now.
      </div>
      {error && <div className="taskadd-error">{error}</div>}
    </div>
  );
}

function DestinationEditor({
  income, accounts, pending, onSingle, onSplit,
}: {
  income: IncomeView;
  accounts: AccountOption[];
  pending: boolean;
  onSingle: (accountId: number | null) => void;
  onSplit: (allocations: AllocationInput[]) => void;
}) {
  const [mode, setMode] = useState<"single" | "split">(income.allocations.length ? "split" : "single");
  const [single, setSingle] = useState<string>(
    income.destinationAccountId != null ? String(income.destinationAccountId) : "",
  );
  const [rows, setRows] = useState<{ accountId: string; type: string; value: string }[]>(
    income.allocations.length
      ? income.allocations.map((a) => ({ accountId: String(a.accountId), type: a.allocationType, value: a.value != null ? String(a.value) : "" }))
      : [{ accountId: "", type: "fixed", value: "" }],
  );

  const allocInputs: AllocationInput[] = rows
    .filter((r) => r.accountId !== "")
    .map((r) => ({
      accountId: Number(r.accountId),
      allocationType: r.type as AllocationInput["allocationType"],
      value: r.type === "remainder" || r.value === "" ? null : Number(r.value),
    }));
  const gross = income.expectedAmount;
  const preview = useMemo(() => computeAllocationShares(gross, allocInputs), [gross, JSON.stringify(allocInputs)]);
  const nameOf = (id: number) => accounts.find((a) => a.id === id)?.name ?? `#${id}`;

  return (
    <div className="fin-dest-editor">
      <div className="fin-mode-toggle">
        <button className={`linkbtn ${mode === "single" ? "on" : ""}`} onClick={() => setMode("single")} type="button">Single account</button>
        <button className={`linkbtn ${mode === "split" ? "on" : ""}`} onClick={() => setMode("split")} type="button">Split</button>
      </div>

      {mode === "single" ? (
        <div className="fin-pay">
          <label className="fin-field">
            <span>Destination account</span>
            <select value={single} onChange={(e) => setSingle(e.target.value)} disabled={pending}>
              <option value="">Unassigned</option>
              {accounts.map((a) => (<option key={a.id} value={a.id}>{a.name}{a.linked ? " (linked)" : ""}</option>))}
            </select>
          </label>
          <button className="btn" disabled={pending} onClick={() => onSingle(single === "" ? null : Number(single))}>Save destination</button>
        </div>
      ) : (
        <div className="fin-split">
          {rows.map((r, idx) => (
            <div className="fin-split-row" key={idx}>
              <select value={r.accountId} disabled={pending}
                onChange={(e) => setRows(rows.map((x, i) => i === idx ? { ...x, accountId: e.target.value } : x))}>
                <option value="">Account…</option>
                {accounts.map((a) => (<option key={a.id} value={a.id}>{a.name}{a.linked ? " (linked)" : ""}</option>))}
              </select>
              <select value={r.type} disabled={pending}
                onChange={(e) => setRows(rows.map((x, i) => i === idx ? { ...x, type: e.target.value } : x))}>
                <option value="fixed">Fixed $</option>
                <option value="percent">% of remaining</option>
                <option value="remainder">Remainder</option>
              </select>
              <input type="number" step="0.01" placeholder={r.type === "percent" ? "%" : r.type === "remainder" ? "—" : "$"}
                value={r.value} disabled={pending || r.type === "remainder"}
                onChange={(e) => setRows(rows.map((x, i) => i === idx ? { ...x, value: e.target.value } : x))} />
              <button className="linkbtn danger" type="button" disabled={pending || rows.length === 1}
                onClick={() => setRows(rows.filter((_, i) => i !== idx))}>✕</button>
            </div>
          ))}
          <button className="linkbtn" type="button" disabled={pending}
            onClick={() => setRows([...rows, { accountId: "", type: "fixed", value: "" }])}>+ Add allocation</button>

          <div className="fin-split-preview">
            <div className="sub">Preview on {money(gross)} expected:</div>
            {preview.error ? (
              <div className="taskadd-error">{preview.error}</div>
            ) : (
              <ul className="fin-preview-list">
                {preview.shares.map((s, i) => (
                  <li key={i}><span>{nameOf(s.accountId)}</span><span className="num">{money(s.cents / 100)}</span></li>
                ))}
              </ul>
            )}
          </div>
          <button className="btn" disabled={pending || !!preview.error}
            onClick={() => onSplit(allocInputs)}>Save split</button>
        </div>
      )}
    </div>
  );
}

function ReceiveForm({ income, pending, linkedBlocked, onConfirm }: {
  income: IncomeView;
  pending: boolean;
  linkedBlocked: boolean;
  onConfirm: (actualAmount: number | undefined, receivedDate: string | undefined) => void;
}) {
  const [amount, setAmount] = useState<string>(String(income.expectedAmount));
  const [date, setDate] = useState<string>("");
  const hasDest = income.allocations.length > 0 || income.destinationAccountId != null;
  const canReceive = hasDest && !linkedBlocked;
  return (
    <div className="fin-pay">
      <label className="fin-field">
        <span>Actual gross</span>
        <input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={pending || linkedBlocked} />
      </label>
      <label className="fin-field">
        <span>Received date</span>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={pending || linkedBlocked} />
      </label>
      <button className="btn" disabled={pending || !canReceive}
        onClick={() => onConfirm(amount === "" ? undefined : Number(amount), date || undefined)}>
        Mark received
      </button>
      {linkedBlocked ? (
        <span className="sub unassigned-text">
          Linked-account income must be confirmed through a future bank sync. Use a
          manual account for now.
        </span>
      ) : !hasDest ? (
        <span className="sub unassigned-text">Assign a destination first.</span>
      ) : null}
    </div>
  );
}

function AddIncome({ pending, onAdd }: { pending: boolean; onAdd: (b: Record<string, unknown>) => Promise<boolean> }) {
  const [source, setSource] = useState("");
  const [amount, setAmount] = useState("");
  const [payDate, setPayDate] = useState("");
  return (
    <form className="fin-bill-add" onSubmit={async (e) => {
      e.preventDefault();
      if (!source.trim() || !amount || !payDate) return;
      if (await onAdd({ source: source.trim(), expectedAmount: Number(amount), payDate })) {
        setSource(""); setAmount(""); setPayDate("");
      }
    }}>
      <input className="taskadd-title" placeholder="Income source" value={source} onChange={(e) => setSource(e.target.value)} disabled={pending} />
      <input className="taskadd-field" type="number" step="0.01" placeholder="Expected amount" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={pending} />
      <input className="taskadd-field" type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} disabled={pending} />
      <button className="btn" type="submit" disabled={pending || !source.trim() || !amount || !payDate}>Add income</button>
    </form>
  );
}
