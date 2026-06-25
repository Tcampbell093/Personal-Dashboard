"use client";

/* Account management island for /finances (Finance 1A.1).
 *
 * Lists the owner's accounts as cards and provides add / edit / delete. Every
 * balance is labeled as a manually entered actual balance — never a projection
 * and never framed as spendable-now. Credit accounts are shown as liabilities.
 * Mutations go through /api/finances/accounts then router.refresh() recomputes
 * totals server-side. */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AccountView } from "@/lib/types";

const TYPES = ["checking", "savings", "cash", "credit", "other"] as const;
const PURPOSES = ["spending", "bills", "savings", "emergency", "cash", "other"] as const;

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
async function readError(res: Response): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  return data?.error ?? `Request failed (${res.status}).`;
}

interface Draft {
  name: string;
  institution: string;
  type: string;
  purpose: string;
  currentBalance: string;
  includeInSpendable: boolean;
  active: boolean;
}

const EMPTY: Draft = {
  name: "",
  institution: "",
  type: "checking",
  purpose: "spending",
  currentBalance: "",
  includeInSpendable: true,
  active: true,
};

export function AccountManager({
  accounts,
  reconcilableIds = [],
}: {
  accounts: AccountView[];
  reconcilableIds?: number[];
}) {
  const router = useRouter();
  const reconcilable = new Set(reconcilableIds);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

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

  const post = (draft: Draft) =>
    mutate("/api/finances/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(serialize(draft)),
    });

  const patch = (id: number, draft: Draft) =>
    mutate(`/api/finances/accounts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(serialize(draft)),
    });

  return (
    <div className="fin-accounts">
      {accounts.length === 0 && (
        <div className="empty">
          No accounts yet. Add your real accounts to see your cash at a glance.
        </div>
      )}

      <div className="fin-acct-grid">
        {accounts.map((a) =>
          editingId === a.id ? (
            <AccountForm
              key={a.id}
              initial={toDraft(a)}
              pending={pending}
              submitLabel="Save"
              onCancel={() => setEditingId(null)}
              onSubmit={async (draft) => {
                if (await patch(a.id, draft)) setEditingId(null);
              }}
            />
          ) : (
            <AccountCard
              key={a.id}
              account={a}
              reversible={reconcilable.has(a.id)}
              pending={pending}
              onEdit={() => {
                setEditingId(a.id);
                setAdding(false);
              }}
              onReconcile={(realBalance, note) =>
                mutate(`/api/finances/accounts/${a.id}/reconcile`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ realBalance, note }),
                })
              }
              onUndoReconcile={() =>
                mutate(`/api/finances/accounts/${a.id}/reconcile/undo`, { method: "POST" })
              }
              onDelete={() => {
                if (
                  confirm(
                    `Remove “${a.name}”? Its balance is removed from your totals (the record is archived, not erased).`,
                  )
                ) {
                  mutate(`/api/finances/accounts/${a.id}`, { method: "DELETE" });
                }
              }}
            />
          ),
        )}
      </div>

      {adding ? (
        <AccountForm
          initial={EMPTY}
          pending={pending}
          submitLabel="Add account"
          onCancel={() => setAdding(false)}
          onSubmit={async (draft) => {
            if (await post(draft)) setAdding(false);
          }}
        />
      ) : (
        <button
          className="btn"
          onClick={() => {
            setAdding(true);
            setEditingId(null);
          }}
          disabled={pending}
        >
          + Add account
        </button>
      )}

      {error && <div className="taskadd-error">{error}</div>}
    </div>
  );
}

function reconciledLabel(iso: string | null): string {
  if (!iso) return "Not yet reconciled";
  return `Last reconciled ${new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
}

function AccountCard({
  account: a,
  reversible,
  pending,
  onEdit,
  onReconcile,
  onUndoReconcile,
  onDelete,
}: {
  account: AccountView;
  reversible: boolean;
  pending: boolean;
  onEdit: () => void;
  onReconcile: (realBalance: number, note: string | null) => Promise<boolean>;
  onUndoReconcile: () => void;
  onDelete: () => void;
}) {
  const [reconciling, setReconciling] = useState(false);
  const balanceLabel = a.isLiability ? "Manual balance owed" : "Manual balance";
  const isManual = a.balanceSource === "manual";
  return (
    <div className={`fin-acct${a.active ? "" : " inactive"}`}>
      <div className="fin-acct-top">
        <div>
          <div className="fin-acct-name">{a.name}</div>
          <div className="fin-acct-meta">
            {a.institution ? `${a.institution} · ` : ""}
            {cap(a.type)} · {cap(a.purpose)}
          </div>
        </div>
        <div className={`fin-acct-bal num${a.isLiability ? " liab" : ""}`}>
          {money(a.currentBalance)}
        </div>
      </div>
      <div className="fin-acct-tags">
        <span className="fin-tag muted">{balanceLabel}</span>
        {a.isLiability && <span className="fin-tag liab">Liability — not cash</span>}
        {a.isCash &&
          (a.includeInSpendable ? (
            <span className="fin-tag good">Spendable</span>
          ) : (
            <span className="fin-tag muted">Excluded from spendable</span>
          ))}
        {!a.active && <span className="fin-tag muted">Inactive</span>}
        {a.balanceSource !== "manual" && (
          <span className="fin-tag">{cap(a.balanceSource)}</span>
        )}
      </div>
      <div className="fin-acct-reconciled sub">{reconciledLabel(a.lastReconciledAt)}</div>
      <div className="fin-acct-actions">
        <button className="linkbtn" onClick={onEdit} disabled={pending}>
          Edit
        </button>
        {isManual && a.active && (
          <button className="linkbtn" onClick={() => setReconciling((v) => !v)} disabled={pending}>
            {reconciling ? "Close" : "Reconcile"}
          </button>
        )}
        {isManual && reversible && (
          <button className="linkbtn" onClick={onUndoReconcile} disabled={pending}
            title="Undo the latest reconciliation and restore the prior balance">
            Undo reconcile
          </button>
        )}
        <button className="linkbtn danger" onClick={onDelete} disabled={pending}>
          Remove
        </button>
      </div>
      {reconciling && (
        <ReconcilePanel
          account={a}
          pending={pending}
          onCancel={() => setReconciling(false)}
          onConfirm={async (real, note) => {
            if (await onReconcile(real, note)) setReconciling(false);
          }}
        />
      )}
    </div>
  );
}

function ReconcilePanel({
  account: a,
  pending,
  onConfirm,
  onCancel,
}: {
  account: AccountView;
  pending: boolean;
  onConfirm: (realBalance: number, note: string | null) => void;
  onCancel: () => void;
}) {
  const [real, setReal] = useState<string>(String(a.currentBalance));
  const [note, setNote] = useState("");
  const realNum = Number(real);
  const valid = real !== "" && Number.isFinite(realNum);
  const delta = valid ? Math.round((realNum - a.currentBalance) * 100) / 100 : 0;
  return (
    <div className="fin-reconcile">
      <div className="fin-reconcile-row">
        <span className="k">App balance</span>
        <span className="num">{money(a.currentBalance)}</span>
      </div>
      <label className="fin-field">
        <span>Real bank balance</span>
        <input type="number" step="0.01" value={real} onChange={(e) => setReal(e.target.value)} disabled={pending} />
      </label>
      <div className="fin-reconcile-row">
        <span className="k">Adjustment</span>
        <span className={`num ${delta < 0 ? "liab" : delta > 0 ? "good" : "muted"}`}>
          {delta > 0 ? "+" : ""}{money(delta)}
        </span>
      </div>
      <label className="fin-field">
        <span>Note (optional)</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. bank fee" disabled={pending} />
      </label>
      <div className="fin-form-actions">
        <button className="btn" disabled={pending || !valid} onClick={() => onConfirm(realNum, note || null)}>
          Confirm reconciliation
        </button>
        <button className="linkbtn" onClick={onCancel} disabled={pending}>Cancel</button>
      </div>
      <div className="fin-form-note">
        Reconciling records an auditable adjustment and updates the manual actual
        balance — it never overwrites your ledger history.
      </div>
    </div>
  );
}

function AccountForm({
  initial,
  pending,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: Draft;
  pending: boolean;
  submitLabel: string;
  onSubmit: (draft: Draft) => void;
  onCancel: () => void;
}) {
  const [d, setD] = useState<Draft>(initial);
  const set = (patch: Partial<Draft>) => setD((prev) => ({ ...prev, ...patch }));

  return (
    <form
      className="fin-acct-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!d.name.trim()) return;
        onSubmit({ ...d, name: d.name.trim(), institution: d.institution.trim() });
      }}
    >
      <div className="fin-form-row">
        <label className="fin-field">
          <span>Account name</span>
          <input
            value={d.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="e.g. Chase checking"
            disabled={pending}
          />
        </label>
        <label className="fin-field">
          <span>Institution (optional)</span>
          <input
            value={d.institution}
            onChange={(e) => set({ institution: e.target.value })}
            placeholder="e.g. Chase"
            disabled={pending}
          />
        </label>
      </div>
      <div className="fin-form-row">
        <label className="fin-field">
          <span>Type</span>
          <select
            value={d.type}
            onChange={(e) => set({ type: e.target.value })}
            disabled={pending}
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {cap(t)}
              </option>
            ))}
          </select>
        </label>
        <label className="fin-field">
          <span>Purpose</span>
          <select
            value={d.purpose}
            onChange={(e) => set({ purpose: e.target.value })}
            disabled={pending}
          >
            {PURPOSES.map((p) => (
              <option key={p} value={p}>
                {cap(p)}
              </option>
            ))}
          </select>
        </label>
        <label className="fin-field">
          <span>{d.type === "credit" ? "Balance owed" : "Actual balance"}</span>
          <input
            type="number"
            step="0.01"
            value={d.currentBalance}
            onChange={(e) => set({ currentBalance: e.target.value })}
            placeholder="0.00"
            disabled={pending}
          />
        </label>
      </div>
      <div className="fin-form-checks">
        <label className="fin-check">
          <input
            type="checkbox"
            checked={d.includeInSpendable}
            onChange={(e) => set({ includeInSpendable: e.target.checked })}
            disabled={pending || d.type === "credit"}
          />
          <span>Count toward spendable cash</span>
        </label>
        <label className="fin-check">
          <input
            type="checkbox"
            checked={d.active}
            onChange={(e) => set({ active: e.target.checked })}
            disabled={pending}
          />
          <span>Active</span>
        </label>
      </div>
      {d.type === "credit" && (
        <div className="fin-form-note">
          Credit accounts are liabilities. Enter the amount you owe — it is shown
          separately and never added to your cash.
        </div>
      )}
      <div className="fin-form-actions">
        <button className="btn" type="submit" disabled={pending || !d.name.trim()}>
          {submitLabel}
        </button>
        <button className="linkbtn" type="button" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function toDraft(a: AccountView): Draft {
  return {
    name: a.name,
    institution: a.institution ?? "",
    type: a.type,
    purpose: a.purpose,
    currentBalance: String(a.currentBalance),
    includeInSpendable: a.includeInSpendable,
    active: a.active,
  };
}

function serialize(d: Draft) {
  return {
    name: d.name,
    institution: d.institution || null,
    type: d.type,
    purpose: d.purpose,
    currentBalance: d.currentBalance === "" ? 0 : Number(d.currentBalance),
    // Credit accounts are never spendable cash regardless of the checkbox.
    includeInSpendable: d.type === "credit" ? false : d.includeInSpendable,
    active: d.active,
  };
}
