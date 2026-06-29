"use client";

/* Finance 1B.3A (+ 1B.3A.1) — Imported activity (Plaid Sandbox transactions).
 *
 * A SEPARATE section from "Recent activity" (the Xanther/manual-command ledger).
 * Imported transactions are bank EVIDENCE — read-only, no matching, no
 * confirmation actions. 1B.3A.1 adds usability: only the most recent 10 rows show
 * by default ("Show more"/"Show less"), plus small Account / Status / Date-range
 * filters. All filtering + pagination is CLIENT-SIDE over a single bounded,
 * deterministically-ordered fetch — filters never trigger a sync or mutate data.
 * No account numbers, provider ids, or balances are shown. */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConnectionView, ImportedTransactionView } from "@/lib/types";

const PAGE = 10; // initial + "show more" batch size
const FETCH_LIMIT = 500; // single bounded fetch (route is also capped at 500)
const money = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type DateRange = "30" | "90" | "all";
type StatusFilter = "all" | "posted" | "pending";
type AccountFilter = "all" | "none" | number; // 'none' = unmapped ("Not added to Xanther")

function cutoffIso(range: DateRange): string | null {
  if (range === "all") return null;
  const d = new Date();
  d.setDate(d.getDate() - (range === "30" ? 30 : 90));
  return d.toISOString().slice(0, 10);
}

interface AutoStatus { configured: boolean; processorConfigured: boolean; lastSyncedAt: string | null; pending: boolean; failed: boolean }

export function ImportedActivity({ connections, autoStatus }: { connections: ConnectionView[]; autoStatus: AutoStatus }) {
  const [txns, setTxns] = useState<ImportedTransactionView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [syncing, setSyncing] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [dateRange, setDateRange] = useState<DateRange>("90");
  const [account, setAccount] = useState<AccountFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [visible, setVisible] = useState(PAGE);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/finances/transactions?status=active&limit=${FETCH_LIMIT}`);
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

  // Account-filter options derived from the fetched (active) transactions only.
  const accountOptions = useMemo(() => {
    const seen = new Map<number, string>();
    let hasUnmapped = false;
    for (const t of txns) {
      if (t.financialAccountId != null) seen.set(t.financialAccountId, t.accountLabel);
      else hasUnmapped = true;
    }
    return { mapped: [...seen.entries()], hasUnmapped };
  }, [txns]);

  // Client-side filtering — deterministic (preserves the server's ordering).
  const filtered = useMemo(() => {
    const cutoff = cutoffIso(dateRange);
    return txns.filter((t) => {
      if (account === "none" && t.financialAccountId != null) return false;
      if (typeof account === "number" && t.financialAccountId !== account) return false;
      if (status === "posted" && t.isPending) return false;
      if (status === "pending" && !t.isPending) return false;
      if (cutoff && (t.date ?? "0000-00-00") < cutoff) return false;
      return true;
    });
  }, [txns, dateRange, account, status]);

  // Any filter change resets the visible window to the initial batch.
  const resetVisible = useCallback(() => setVisible(PAGE), []);
  useEffect(() => { resetVisible(); }, [dateRange, account, status, resetVisible]);

  const syncConnection = useCallback(async (connectionId: number) => {
    if (syncing != null) return; // prevent overlapping syncs
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

  const shown = filtered.slice(0, visible);

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
            <button key={c.id} type="button" className="btn" disabled={syncing != null} aria-busy={syncing === c.id} onClick={() => syncConnection(c.id)}>
              {syncing === c.id ? "Syncing…" : `Sync transactions · ${c.institutionName}`}
            </button>
          ))
        )}
      </div>

      <p className="sub">
        {!autoStatus.configured
          ? "Automatic updates aren’t configured — use Sync transactions to import new activity."
          : !autoStatus.processorConfigured
            ? "Automatic processing is not fully configured — notifications can be received, but background processing requires configuration. You can still Sync transactions manually."
            : autoStatus.pending
              ? "A bank notification was received — syncing new activity…"
              : autoStatus.failed
                ? "Automatic sync didn’t complete and will retry. You can also Sync transactions manually."
                : "Automatic updates are on — new activity imports when your bank reports it. You can also sync manually."}
        {autoStatus.lastSyncedAt && (
          <> Last automatic sync {new Date(autoStatus.lastSyncedAt).toLocaleString()}.</>
        )}
      </p>

      {error && <p className="taskadd-error" role="alert">{error}</p>}

      {loaded && txns.length > 0 && (
        <div className="fin-txn-filters" role="group" aria-label="Imported activity filters">
          <label className="fin-txn-filter">
            <span className="sub">Account</span>
            <select value={String(account)} onChange={(e) => setAccount(e.target.value === "all" ? "all" : e.target.value === "none" ? "none" : Number(e.target.value))}>
              <option value="all">All accounts</option>
              {accountOptions.mapped.map(([id, label]) => (<option key={id} value={id}>{label}</option>))}
              {accountOptions.hasUnmapped && <option value="none">Not added to Xanther</option>}
            </select>
          </label>
          <label className="fin-txn-filter">
            <span className="sub">Status</span>
            <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
              <option value="all">All</option>
              <option value="posted">Posted</option>
              <option value="pending">Pending</option>
            </select>
          </label>
          <label className="fin-txn-filter">
            <span className="sub">Date</span>
            <select value={dateRange} onChange={(e) => setDateRange(e.target.value as DateRange)}>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="all">All imported history</option>
            </select>
          </label>
        </div>
      )}

      {!loaded ? (
        <p className="sub">Loading imported activity…</p>
      ) : txns.length === 0 ? (
        <p className="empty">{connections.length === 0 ? "No imported transactions yet." : "Sync transactions to retrieve Sandbox activity."}</p>
      ) : filtered.length === 0 ? (
        <p className="empty">No imported transactions for the selected filters.</p>
      ) : (
        <>
          <p className="sub fin-txn-count">Showing {shown.length} of {filtered.length} transactions</p>
          <ul className="fin-txn-list">
            {shown.map((t) => (
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
                </div>
              </li>
            ))}
          </ul>
          <div className="fin-txn-pager">
            {visible < filtered.length && (
              <button type="button" className="linkbtn" onClick={() => setVisible((v) => v + PAGE)}>Show more</button>
            )}
            {visible > PAGE && (
              <button type="button" className="linkbtn" onClick={resetVisible}>Show less</button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
