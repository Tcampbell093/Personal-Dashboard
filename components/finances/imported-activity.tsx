"use client";

/* Finance 1B.3A — Imported activity (Plaid Sandbox transactions).
 *
 * A SEPARATE section from "Recent activity" (the Xanther/manual-command ledger).
 * Imported transactions are bank EVIDENCE — read-only, no matching, no
 * confirmation actions. The owner presses "Sync transactions" (per connection) to
 * retrieve fake Sandbox activity; rows show a signed amount (+inflow / −outflow),
 * the linked account label (or "Not added to Xanther"), a Pending/Posted badge,
 * and a date. No account numbers, provider ids, or balances are shown. */

import { useCallback, useEffect, useState } from "react";
import type { ConnectionView, ImportedTransactionView } from "@/lib/types";

const money = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function ImportedActivity({ connections }: { connections: ConnectionView[] }) {
  const [txns, setTxns] = useState<ImportedTransactionView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [syncing, setSyncing] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/finances/transactions?status=active&limit=50");
      if (res.ok) {
        const data = (await res.json()) as { transactions: ImportedTransactionView[] };
        setTxns(data.transactions);
      }
    } catch {
      /* keep current list on transient failure */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const syncConnection = useCallback(async (connectionId: number) => {
    if (syncing != null) return; // prevent overlapping syncs (not just button-disable)
    setError(null);
    setSyncing(connectionId);
    try {
      const res = await fetch(`/api/finances/connections/${connectionId}/transactions/sync`, { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Could not sync transactions.");
      } else {
        await refresh();
      }
    } catch {
      setError("Could not sync transactions.");
    } finally {
      setSyncing(null);
    }
  }, [syncing, refresh]);

  return (
    <div className="fin-imported">
      <p className="fin-form-note">
        Imported activity comes from the connected bank provider (fake Plaid Sandbox data). It is
        separate from <strong>Recent activity</strong>, which records actions performed through Xanther.
      </p>

      <div className="fin-imported-actions">
        {connections.length === 0 ? (
          <span className="sub">Connect a bank to sync transactions.</span>
        ) : (
          connections.map((c) => (
            <button
              key={c.id}
              type="button"
              className="btn"
              disabled={syncing != null}
              aria-busy={syncing === c.id}
              onClick={() => syncConnection(c.id)}
            >
              {syncing === c.id ? "Syncing…" : `Sync transactions · ${c.institutionName}`}
            </button>
          ))
        )}
      </div>
      {connections.some((c) => c.lastTransactionSyncedAt) && (
        <p className="sub">
          Last synced{" "}
          {new Date(
            connections.map((c) => c.lastTransactionSyncedAt).filter(Boolean).sort().reverse()[0] as string,
          ).toLocaleString()}
          .
        </p>
      )}

      {error && <p className="taskadd-error" role="alert">{error}</p>}

      {!loaded ? (
        <p className="sub">Loading imported activity…</p>
      ) : txns.length === 0 ? (
        <p className="empty">
          {connections.length === 0
            ? "No imported transactions yet."
            : "Sync transactions to retrieve Sandbox activity."}
        </p>
      ) : (
        <ul className="fin-txn-list">
          {txns.map((t) => (
            <li key={t.id} className="fin-txn-row">
              <div className="fin-txn-main">
                <span className="fin-txn-desc">{t.merchantName ?? t.descriptionCurrent}</span>
                <span className={`fin-txn-amt ${t.amount >= 0 ? "good" : ""}`}>{money(t.amount)}</span>
              </div>
              <div className="fin-txn-meta sub">
                <span>{t.accountLabel}</span>
                <span aria-hidden>·</span>
                <span className={`fin-tag ${t.isPending ? "muted" : "sandbox"}`}>{t.isPending ? "Pending" : "Posted"}</span>
                {t.date && (<><span aria-hidden>·</span><span>{t.date}</span></>)}
                {!t.mapped && (<><span aria-hidden>·</span><span>This account has not been added to Xanther</span></>)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
