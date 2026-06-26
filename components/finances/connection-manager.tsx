"use client";

/* Finance 1B.1 — Bank connections (Plaid Sandbox).
 *
 * Read-only connect flow ONLY. The browser receives just a short-lived Link
 * token (never the client id, Plaid secret, or any stored access token), posts
 * the public token to the authenticated exchange route, and shows a truthful
 * Sandbox connection status. No accounts, balances, or transactions are shown —
 * those arrive in a later phase. The official Plaid Link script is loaded from
 * Plaid's CDN (no extra npm dependency); a typed fallback message appears if it
 * cannot open. */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionView } from "@/lib/types";

const PLAID_SCRIPT = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

type PlaidHandler = { open: () => void; exit: () => void; destroy: () => void };
type PlaidGlobal = {
  create: (cfg: {
    token: string;
    onSuccess: (publicToken: string) => void;
    onExit: (err: unknown) => void;
    onLoad?: () => void;
  }) => PlaidHandler;
};

let scriptPromise: Promise<boolean> | null = null;
function loadPlaidScript(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if ((window as unknown as { Plaid?: PlaidGlobal }).Plaid) return Promise.resolve(true);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<boolean>((resolve) => {
    const existing = document.querySelector(`script[src="${PLAID_SCRIPT}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(true));
      existing.addEventListener("error", () => resolve(false));
      return;
    }
    const s = document.createElement("script");
    s.src = PLAID_SCRIPT;
    s.async = true;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
  return scriptPromise;
}

const STATUS_LABEL: Record<string, string> = {
  active: "Connected in Sandbox",
  login_required: "Reconnect needed",
  pending_expiration: "Reconnect soon",
  error: "Connection error",
  revoked: "Disconnected",
};

export function ConnectionManager({ initialConnections }: { initialConnections: ConnectionView[] }) {
  const [connections, setConnections] = useState<ConnectionView[]>(initialConnections);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scriptReady, setScriptReady] = useState(false);
  const handlerRef = useRef<PlaidHandler | null>(null);

  useEffect(() => {
    let alive = true;
    loadPlaidScript().then((ok) => { if (alive) setScriptReady(ok); });
    return () => { alive = false; };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/finances/connections");
      if (res.ok) {
        const data = (await res.json()) as { connections: ConnectionView[] };
        setConnections(data.connections);
      }
    } catch {
      /* keep the current list on a transient refresh failure */
    }
  }, []);

  const handleConnect = useCallback(async () => {
    if (linking) return; // prevent overlapping Link sessions
    setError(null);
    setLinking(true);
    try {
      const res = await fetch("/api/finances/connections/link-token", { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Could not start a bank connection.");
        setLinking(false);
        return;
      }
      const { linkToken } = (await res.json()) as { linkToken: string };
      const ok = await loadPlaidScript();
      const Plaid = (window as unknown as { Plaid?: PlaidGlobal }).Plaid;
      if (!ok || !Plaid) {
        setError("Plaid Link could not load. Please check your connection and try again.");
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
            if (!ex.ok) {
              const data = (await ex.json().catch(() => ({}))) as { error?: string };
              setError(data.error ?? "Could not complete the connection.");
            } else {
              await refresh();
            }
          } catch {
            setError("Could not complete the connection.");
          } finally {
            setLinking(false);
          }
        },
        onExit: (err: unknown) => {
          // Cancellation is non-destructive — nothing is stored.
          setLinking(false);
          if (err) setError("Bank connection was not completed.");
        },
      });
      handlerRef.current.open();
    } catch {
      setError("Could not start a bank connection.");
      setLinking(false);
    }
  }, [linking, refresh]);

  return (
    <div className="fin-conn">
      <div className="fin-conn-actions">
        <button
          type="button"
          className="btn"
          onClick={handleConnect}
          disabled={linking}
          aria-busy={linking}
        >
          {linking ? "Connecting…" : "Connect bank"}
        </button>
        <p className="fin-form-note">
          This phase uses <strong>fake Plaid Sandbox institutions and test data</strong> — not a real
          bank. Accounts and balances are added in the next phase.
        </p>
      </div>

      {error && (
        <p className="taskadd-error" role="alert">
          {error}
        </p>
      )}
      {!scriptReady && (
        <p className="sub">
          If the connect window does not open, Plaid Link may be blocked; you can still use the rest
          of Xanther normally.
        </p>
      )}

      {connections.length === 0 ? (
        <p className="empty">No bank connections yet.</p>
      ) : (
        <ul className="fin-conn-list">
          {connections.map((c) => (
            <li key={c.id} className="fin-conn-row">
              <div className="fin-conn-top">
                <span className="fin-conn-name">{c.institutionName}</span>
                <span className="fin-tag sandbox">Sandbox</span>
                {c.requiresReauth && <span className="fin-tag liab">Reconnect needed</span>}
              </div>
              <div className="fin-conn-meta sub">
                <span>{STATUS_LABEL[c.status] ?? c.status}</span>
                <span aria-hidden>·</span>
                <span>{c.provider}</span>
                {c.connectedAt && (
                  <>
                    <span aria-hidden>·</span>
                    <span>Connected {new Date(c.connectedAt).toLocaleDateString()}</span>
                  </>
                )}
              </div>
              <p className="fin-conn-phase sub">
                This connection uses fake Plaid test data. Accounts and balances are not available
                yet.
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
