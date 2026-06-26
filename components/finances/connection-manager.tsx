"use client";

/* Finance 1B.1 + 1B.2 — Bank connections (Plaid Sandbox).
 *
 * Read-only. 1B.1: connect via Plaid Link. 1B.2: discover provider accounts +
 * cached balances for a connection, and create a NEW linked Xanther account from
 * an unmapped provider account (never merging an existing manual account, never
 * moving money). The browser only ever receives a short-lived Link token and
 * NONSECRET views — never a client id, Plaid secret, access token, or encrypted
 * field. Cached balances are labeled truthfully (never "live"). */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ConnectionView, ProviderAccountView } from "@/lib/types";

const PLAID_SCRIPT = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
const PURPOSES = ["spending", "bills", "savings", "emergency", "cash", "other"] as const;

type PlaidHandler = { open: () => void; exit: () => void; destroy: () => void };
type PlaidGlobal = {
  create: (cfg: { token: string; onSuccess: (publicToken: string) => void; onExit: (err: unknown) => void }) => PlaidHandler;
};

let scriptPromise: Promise<boolean> | null = null;
function loadPlaidScript(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if ((window as unknown as { Plaid?: PlaidGlobal }).Plaid) return Promise.resolve(true);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<boolean>((resolve) => {
    const s = document.createElement("script");
    s.src = PLAID_SCRIPT;
    s.async = true;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
  return scriptPromise;
}

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function freshLabel(iso: string | null): string {
  if (!iso) return "unknown";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString();
}

const STATUS_LABEL: Record<string, string> = {
  active: "Connected in Sandbox",
  login_required: "Reconnect needed",
  pending_expiration: "Reconnect soon",
  error: "Connection error",
  revoked: "Disconnected",
};

interface AddDraft {
  providerAccountId: number;
  name: string;
  purpose: string;
  includeInSpendable: boolean;
}

export function ConnectionManager({ initialConnections }: { initialConnections: ConnectionView[] }) {
  const router = useRouter();
  const [connections, setConnections] = useState<ConnectionView[]>(initialConnections);
  const [accounts, setAccounts] = useState<Record<number, ProviderAccountView[]>>({});
  const [linking, setLinking] = useState(false);
  const [syncingId, setSyncingId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [add, setAdd] = useState<AddDraft | null>(null);
  const handlerRef = useRef<PlaidHandler | null>(null);

  const loadAccounts = useCallback(async (connId: number) => {
    try {
      const res = await fetch(`/api/finances/connections/${connId}/accounts`);
      if (res.ok) {
        const data = (await res.json()) as { accounts: ProviderAccountView[] };
        setAccounts((m) => ({ ...m, [connId]: data.accounts }));
      }
    } catch {
      /* keep current */
    }
  }, []);

  useEffect(() => {
    let alive = true;
    loadPlaidScript();
    (async () => {
      for (const c of initialConnections) if (alive) await loadAccounts(c.id);
    })();
    return () => { alive = false; };
  }, [initialConnections, loadAccounts]);

  const refreshConnections = useCallback(async () => {
    try {
      const res = await fetch("/api/finances/connections");
      if (res.ok) setConnections(((await res.json()) as { connections: ConnectionView[] }).connections);
    } catch { /* ignore */ }
  }, []);

  const handleConnect = useCallback(async () => {
    if (linking) return;
    setError(null);
    setLinking(true);
    try {
      const res = await fetch("/api/finances/connections/link-token", { method: "POST" });
      if (!res.ok) {
        setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not start a bank connection.");
        setLinking(false);
        return;
      }
      const { linkToken } = (await res.json()) as { linkToken: string };
      const ok = await loadPlaidScript();
      const Plaid = (window as unknown as { Plaid?: PlaidGlobal }).Plaid;
      if (!ok || !Plaid) {
        setError("Plaid Link could not load. Please try again.");
        setLinking(false);
        return;
      }
      handlerRef.current = Plaid.create({
        token: linkToken,
        onSuccess: async (publicToken: string) => {
          try {
            const ex = await fetch("/api/finances/connections/exchange", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ publicToken }),
            });
            if (!ex.ok) setError(((await ex.json().catch(() => ({}))) as { error?: string }).error ?? "Could not complete the connection.");
            else { await refreshConnections(); router.refresh(); }
          } catch {
            setError("Could not complete the connection.");
          } finally {
            setLinking(false);
          }
        },
        onExit: (err: unknown) => {
          setLinking(false);
          if (err) setError("Bank connection was not completed.");
        },
      });
      handlerRef.current.open();
    } catch {
      setError("Could not start a bank connection.");
      setLinking(false);
    }
  }, [linking, refreshConnections, router]);

  const syncAccounts = useCallback(async (connId: number) => {
    if (syncingId) return;
    setError(null);
    setSyncingId(connId);
    try {
      const res = await fetch(`/api/finances/connections/${connId}/accounts/sync`, { method: "POST" });
      if (!res.ok) {
        setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not sync accounts.");
      } else {
        const data = (await res.json()) as { accounts: ProviderAccountView[] };
        setAccounts((m) => ({ ...m, [connId]: data.accounts }));
        await refreshConnections();
      }
    } catch {
      setError("Could not sync accounts.");
    } finally {
      setSyncingId(null);
    }
  }, [syncingId, refreshConnections]);

  const submitAdd = useCallback(async (connId: number) => {
    if (!add || creating) return;
    setError(null);
    setCreating(true);
    try {
      const res = await fetch(`/api/finances/provider-accounts/${add.providerAccountId}/create-linked-account`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: add.name, purpose: add.purpose, includeInSpendable: add.includeInSpendable }),
      });
      if (!res.ok) {
        setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not create the linked account.");
      } else {
        setAdd(null);
        await loadAccounts(connId);
        router.refresh(); // update the main Accounts section (server-rendered)
      }
    } catch {
      setError("Could not create the linked account.");
    } finally {
      setCreating(false);
    }
  }, [add, creating, loadAccounts, router]);

  return (
    <div className="fin-conn">
      <div className="fin-conn-actions">
        <button type="button" className="btn" onClick={handleConnect} disabled={linking} aria-busy={linking}>
          {linking ? "Connecting…" : "Connect bank"}
        </button>
        <p className="fin-form-note">
          This phase uses <strong>fake Plaid Sandbox institutions and test data</strong> — not a real
          bank. Accounts and cached balances can be discovered below; transactions arrive in a later phase.
        </p>
      </div>

      {error && <p className="taskadd-error" role="alert">{error}</p>}

      {connections.length === 0 ? (
        <p className="empty">No bank connections yet.</p>
      ) : (
        <ul className="fin-conn-list">
          {connections.map((c) => {
            const accts = accounts[c.id] ?? [];
            return (
              <li key={c.id} className="fin-conn-row">
                <div className="fin-conn-top">
                  <span className="fin-conn-name">{c.institutionName}</span>
                  <span className="fin-tag sandbox">Sandbox</span>
                  {c.requiresReauth && <span className="fin-tag liab">Reconnect needed</span>}
                  <button
                    type="button"
                    className="linkbtn"
                    onClick={() => syncAccounts(c.id)}
                    disabled={syncingId === c.id}
                    aria-busy={syncingId === c.id}
                  >
                    {syncingId === c.id ? "Syncing…" : "Sync accounts"}
                  </button>
                </div>
                <div className="fin-conn-meta sub">
                  <span>{STATUS_LABEL[c.status] ?? c.status}</span>
                  <span aria-hidden>·</span>
                  <span>{c.provider}</span>
                  <span aria-hidden>·</span>
                  <span>{c.lastSyncedAt ? `Accounts synced ${freshLabel(c.lastSyncedAt)}` : "Accounts not synced yet"}</span>
                </div>

                {accts.length > 0 && (
                  <ul className="fin-pa-list">
                    {accts.map((pa) => (
                      <li key={pa.id} className="fin-pa-row">
                        <div className="fin-pa-main">
                          <span className="fin-pa-name">{pa.providerName}</span>
                          <span className="sub">
                            {cap(pa.type)}
                            {pa.subtype ? ` · ${pa.subtype}` : ""}
                            {pa.mask ? ` · ••${pa.mask}` : ""}
                          </span>
                        </div>
                        <div className="fin-pa-bal">
                          {pa.balanceCurrent == null ? (
                            <span className="sub">Balance unavailable</span>
                          ) : (
                            <span className="num">
                              {money(pa.balanceCurrent)} {pa.currency ?? ""}
                            </span>
                          )}
                          <span className="sub fin-pa-fresh">
                            {pa.status === "stale" ? "Last known provider balance" : "Cached Sandbox balance"}
                            {pa.balanceAsOf ? ` · Updated ${freshLabel(pa.balanceAsOf)}` : ""}
                            {pa.balanceAvailable != null ? ` · Available ${money(pa.balanceAvailable)}` : ""}
                          </span>
                        </div>
                        <div className="fin-pa-status">
                          {pa.mapped ? (
                            <span className="fin-tag good">Linked to {pa.linkedAccountName ?? "Xanther"}</span>
                          ) : pa.status === "stale" ? (
                            <>
                              <span className="fin-tag muted">Stale</span>
                              <span className="fin-tag muted">Not added to Xanther</span>
                            </>
                          ) : (
                            <>
                              <span className="fin-tag muted">Not added to Xanther</span>
                              <button
                                type="button"
                                className="linkbtn"
                                onClick={() =>
                                  setAdd({
                                    providerAccountId: pa.id,
                                    name: pa.providerName,
                                    purpose: pa.type === "credit" ? "other" : pa.type === "savings" ? "savings" : "spending",
                                    includeInSpendable: pa.type === "checking",
                                  })
                                }
                                disabled={creating}
                              >
                                Add to Xanther
                              </button>
                            </>
                          )}
                        </div>

                        {add?.providerAccountId === pa.id && (
                          <form
                            className="fin-pa-form"
                            onSubmit={(e) => { e.preventDefault(); submitAdd(c.id); }}
                          >
                            <p className="fin-form-note">
                              This creates a <strong>new linked Xanther account</strong>. It does not merge
                              with your existing manual accounts.
                            </p>
                            <div className="fin-form-row">
                              <label className="fin-field">
                                <span>Xanther account name</span>
                                <input value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} disabled={creating} />
                              </label>
                              <label className="fin-field">
                                <span>Purpose</span>
                                <select value={add.purpose} onChange={(e) => setAdd({ ...add, purpose: e.target.value })} disabled={creating}>
                                  {PURPOSES.map((p) => <option key={p} value={p}>{cap(p)}</option>)}
                                </select>
                              </label>
                            </div>
                            <label className="fin-check">
                              <input
                                type="checkbox"
                                checked={add.includeInSpendable && pa.type !== "credit"}
                                disabled={creating || pa.type === "credit"}
                                onChange={(e) => setAdd({ ...add, includeInSpendable: e.target.checked })}
                              />
                              <span>Count toward spendable cash{pa.type === "credit" ? " (credit accounts can’t be spendable)" : ""}</span>
                            </label>
                            <div className="fin-form-actions">
                              <button type="submit" className="btn" disabled={creating || !add.name.trim()}>
                                {creating ? "Creating…" : "Create linked account"}
                              </button>
                              <button type="button" className="linkbtn" onClick={() => setAdd(null)} disabled={creating}>Cancel</button>
                            </div>
                          </form>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {accts.length === 0 && (
                  <p className="fin-pa-phase sub">No accounts discovered yet — click “Sync accounts”.</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
