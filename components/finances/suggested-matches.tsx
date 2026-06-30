"use client";

/* Finance 1B.4A — Suggested matches (deterministic, suggestion-only).
 *
 * Shows PENDING suggestions linking imported bank evidence to the owner's finance
 * records. The owner reviews, then Confirms or Rejects — Xanther never confirms
 * its own suggestion. Confirmation is offered ONLY where the existing workflow is
 * proven safe (bill payments, manual-destination income); transfer pairs and
 * linked-account income show a clear "confirmation not yet supported" state and
 * can still be reviewed/rejected. Medium-confidence confirmations require an
 * extra in-card confirmation summarizing exactly what will change. */

import { useCallback, useEffect, useMemo, useState } from "react";

const PAGE = 5; // bounded default list
const money = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type SuggestionType = "bill_payment" | "income_receipt" | "transfer_pair";
type TypeFilter = "all" | SuggestionType;

interface TxnRef { id: number; amount: number; date: string | null; description: string; accountLabel: string }
interface TargetRef { kind: "bill" | "income" | "transfer"; id: number | null; name: string; amount: number | null; date: string | null }
export interface MatchSuggestion {
  id: number; suggestionType: SuggestionType; status: string;
  score: number; confidence: "high" | "medium" | "low"; reasonCodes: string[]; explanation: string;
  primary: TxnRef; secondary: TxnRef | null; target: TargetRef | null;
  amountDifference: number | null; dateDifferenceDays: number | null;
  confirmable: boolean; confirmBlockedReason: string | null;
  createdAt: string; reviewedAt: string | null; rejectionReason: string | null;
}

const TYPE_LABEL: Record<SuggestionType, string> = { bill_payment: "Bill payment", income_receipt: "Income", transfer_pair: "Transfer" };
const CONF_LABEL = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" } as const;
const blockedNote = (reason: string | null): string =>
  reason === "transfer_model_gap" ? "Confirmation isn’t supported yet for transfers."
  : reason === "linked_account" ? "Confirmation isn’t supported yet for linked accounts."
  : reason === "no_destination" ? "Assign a destination account before confirming."
  : "Confirmation isn’t available for this suggestion yet.";

export function SuggestedMatches({ initialPendingCount = 0 }: { initialPendingCount?: number }) {
  const [items, setItems] = useState<MatchSuggestion[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [ran, setRan] = useState(false); // a generation has happened this session
  const [generating, setGenerating] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [confirmingId, setConfirmingId] = useState<number | null>(null); // medium-confidence in-card confirm
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState<TypeFilter>("all");
  const [visible, setVisible] = useState(PAGE);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/finances/matches?status=pending");
      if (res.ok) { const data = (await res.json()) as { suggestions: MatchSuggestion[] }; setItems(data.suggestions); }
    } catch { /* keep current list */ } finally { setLoaded(true); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const generate = useCallback(async () => {
    if (generating) return;
    setError(null); setGenerating(true);
    try {
      const res = await fetch("/api/finances/matches/generate", { method: "POST" });
      if (!res.ok) { const d = (await res.json().catch(() => ({}))) as { error?: string }; setError(d.error ?? "Could not find matches."); }
      else { const data = (await res.json()) as { suggestions: MatchSuggestion[] }; setItems(data.suggestions); setRan(true); }
    } catch { setError("Could not find matches."); } finally { setGenerating(false); }
  }, [generating]);

  const act = useCallback(async (id: number, action: "confirm" | "reject") => {
    if (busyId != null) return;
    setError(null); setBusyId(id); setConfirmingId(null);
    try {
      const res = await fetch(`/api/finances/matches/${id}/${action}`, { method: "POST" });
      if (!res.ok) { const d = (await res.json().catch(() => ({}))) as { error?: string }; setError(d.error ?? `Could not ${action} the suggestion.`); }
      await refresh();
    } catch { setError(`Could not ${action} the suggestion.`); } finally { setBusyId(null); }
  }, [busyId, refresh]);

  const filtered = useMemo(() => (type === "all" ? items : items.filter((s) => s.suggestionType === type)), [items, type]);
  useEffect(() => { setVisible(PAGE); }, [type]);
  const shown = filtered.slice(0, visible);

  const emptyMessage = !ran && items.length === 0
    ? "Run Find matches after importing transactions."
    : filtered.length === 0 && items.length > 0
      ? "No suggestions for this filter."
      : ran
        ? "No likely matches found."
        : "No suggestions yet.";

  return (
    <div className="fin-imported">
      <div className="fin-imported-actions">
        <button type="button" className="btn" disabled={generating} aria-busy={generating} onClick={generate}>
          {generating ? "Finding matches…" : "Find matches"}
        </button>
      </div>
      <p className="fin-form-note">
        Xanther suggests how imported bank transactions may relate to your bills, income, and transfers.
        A suggestion never changes anything — you decide. Confirming a bill marks it paid using the
        existing workflow.
      </p>

      {error && <p className="taskadd-error" role="alert">{error}</p>}

      {loaded && items.length > 0 && (
        <div className="fin-txn-filters" role="group" aria-label="Suggestion filters">
          {(["all", "bill_payment", "income_receipt", "transfer_pair"] as TypeFilter[]).map((t) => (
            <button key={t} type="button" className={`fin-chip ${type === t ? "on" : ""}`} aria-pressed={type === t} onClick={() => setType(t)}>
              {t === "all" ? "All" : t === "bill_payment" ? "Bills" : t === "income_receipt" ? "Income" : "Transfers"}
            </button>
          ))}
        </div>
      )}

      {!loaded ? (
        <p className="sub">Loading suggestions…</p>
      ) : shown.length === 0 ? (
        <p className="empty">{emptyMessage}</p>
      ) : (
        <>
          <p className="sub fin-txn-count">Showing {shown.length} of {filtered.length} suggestions</p>
          <ul className="fin-match-list">
            {shown.map((s) => (
              <li key={s.id} className="fin-match-card">
                <div className="fin-match-head">
                  <span className={`fin-tag ${s.suggestionType === "income_receipt" ? "good" : s.suggestionType === "transfer_pair" ? "muted" : ""}`}>{TYPE_LABEL[s.suggestionType]}</span>
                  <span className={`fin-tag conf-${s.confidence}`}>{CONF_LABEL[s.confidence]}</span>
                </div>

                <div className="fin-txn-main">
                  <span className="fin-txn-desc">{s.primary.description}</span>
                  <span className={`fin-txn-amt ${s.primary.amount >= 0 ? "good" : ""}`}>{money(s.primary.amount)}</span>
                </div>
                <div className="fin-txn-meta sub">
                  <span>{s.primary.accountLabel}</span>
                  {s.primary.date && (<><span aria-hidden>·</span><span>{s.primary.date}</span></>)}
                </div>

                {s.target && (
                  <p className="sub fin-match-target">
                    {s.target.kind === "bill" ? "Bill: " : "Income: "}<strong>{s.target.name}</strong>
                    {s.target.amount != null && <> · {money(s.target.kind === "bill" ? -Math.abs(s.target.amount) : Math.abs(s.target.amount))}</>}
                    {s.target.date && <> · due {s.target.date}</>}
                  </p>
                )}
                {s.secondary && (
                  <p className="sub fin-match-target">Other side: <strong>{s.secondary.description}</strong> · {money(s.secondary.amount)} · {s.secondary.accountLabel}</p>
                )}

                <p className="sub fin-match-why">{s.explanation}</p>

                {confirmingId === s.id ? (
                  <div className="fin-match-confirm" role="group" aria-label="Confirm this match">
                    <p className="sub">
                      This will mark <strong>{s.target?.name}</strong> as {s.suggestionType === "bill_payment" ? "paid" : "received"} using the {money(Math.abs(s.primary.amount))} transaction on {s.primary.date ?? "its posted date"}. Continue?
                    </p>
                    <div className="fin-match-actions">
                      <button type="button" className="btn" disabled={busyId != null} onClick={() => act(s.id, "confirm")}>Yes, confirm</button>
                      <button type="button" className="linkbtn" onClick={() => setConfirmingId(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="fin-match-actions">
                    {s.confirmable ? (
                      <button
                        type="button"
                        className="btn"
                        disabled={busyId != null}
                        aria-busy={busyId === s.id}
                        onClick={() => (s.confidence === "high" ? act(s.id, "confirm") : setConfirmingId(s.id))}
                      >
                        Confirm
                      </button>
                    ) : (
                      <span className="sub fin-match-blocked">{blockedNote(s.confirmBlockedReason)}</span>
                    )}
                    <button type="button" className="linkbtn" disabled={busyId != null} onClick={() => act(s.id, "reject")}>Reject</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <div className="fin-txn-pager">
            {visible < filtered.length && (<button type="button" className="linkbtn" onClick={() => setVisible((v) => v + PAGE)}>Show more</button>)}
            {visible > PAGE && (<button type="button" className="linkbtn" onClick={() => setVisible(PAGE)}>Show less</button>)}
          </div>
        </>
      )}
    </div>
  );
}
