"use client";

/* Finance 1B.5B — Spending insights (read-only calculated intelligence).
 *
 * Deterministic period summaries + insight cards + opportunity cards. Each card
 * distinguishes observed fact, calculation, confidence, evidence period, and
 * limitations. Nothing here mutates a transaction, category, balance, or moves
 * money. "Why am I seeing this?" reveals the calculation basis; Dismiss hides an
 * insight for its period only. */

import { useCallback, useEffect, useState } from "react";

const money = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

interface CatTotal { categoryId: number | null; name: string; total: number; count: number; pct: number; change: number; changePct: number | null }
interface MerchTotal { merchant: string; total: number; count: number; share: number; categoryName: string | null }
interface Insight { key: string; type: string; title: string; summary: string; confidence: string; periodStart: string; periodEnd: string; metricValue: number; comparisonValue: number | null; relatedMerchant: string | null; why: string }
interface Opportunity { key: string; type: string; observation: string; why: string; upsideLabel: string; confidence: string; nextAction: string; limitation: string; evidencePeriod: string }
interface View {
  period: { key: string; label: string; start: string; end: string; incomplete: boolean; priorLabel: string };
  coverage: { totalPostedActive: number; uncategorizedCount: number; uncategorizedAmount: number; categorizedAmount: number; coveragePct: number; warning: string | null; shortHistory: boolean };
  totals: { totalSpending: number; transferExcluded: number; incomeExcluded: number };
  categoryTotals: CatTotal[]; merchantTotals: MerchTotal[]; insights: Insight[]; opportunities: Opportunity[];
}
type PeriodKey = "current_month" | "previous_month" | "last_30" | "last_90";
const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: "current_month", label: "This month" }, { key: "previous_month", label: "Last month" },
  { key: "last_30", label: "Last 30 days" }, { key: "last_90", label: "Last 90 days" },
];

export function SpendingInsights() {
  const [period, setPeriod] = useState<PeriodKey>("current_month");
  const [view, setView] = useState<View | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [why, setWhy] = useState<string | null>(null); // insight key whose "why" is expanded
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { const r = await fetch(`/api/finances/insights?period=${period}`); if (r.ok) setView((await r.json()) as View); }
    catch { /* keep */ } finally { setLoaded(true); }
  }, [period]);
  useEffect(() => { void load(); }, [load]);

  const dismiss = useCallback(async (key: string) => {
    setBusy(true);
    try { await fetch(`/api/finances/insights/${encodeURIComponent(key)}/dismiss`, { method: "POST" }); await load(); }
    finally { setBusy(false); }
  }, [load]);

  return (
    <div className="fin-imported">
      <p className="fin-form-note">Read-only spending intelligence, calculated from your categorized transactions. Transfers and income are excluded from spending; nothing here changes a balance or moves money.</p>

      <div className="fin-txn-filters" role="group" aria-label="Insight period">
        {PERIODS.map((p) => (
          <button key={p.key} type="button" className={`fin-chip ${period === p.key ? "on" : ""}`} aria-pressed={period === p.key} onClick={() => setPeriod(p.key)}>{p.label}</button>
        ))}
      </div>

      {!loaded ? (
        <p className="sub">Loading insights…</p>
      ) : !view ? (
        <p className="empty">Could not load insights.</p>
      ) : (
        <>
          <div className="fin-insight-totals">
            <div className="fin-stat"><span className="fin-stat-k">Spending {view.period.incomplete ? "(so far)" : ""}</span><span className="fin-stat-v">{money(view.totals.totalSpending)}</span></div>
            <div className="fin-stat"><span className="fin-stat-k">Categorized</span><span className="fin-stat-v">{money(view.coverage.categorizedAmount)}</span><span className="fin-stat-note">{view.coverage.coveragePct}% of spending</span></div>
            <div className="fin-stat"><span className="fin-stat-k">Uncategorized</span><span className="fin-stat-v">{money(view.coverage.uncategorizedAmount)}</span><span className="fin-stat-note">{view.coverage.uncategorizedCount} transactions</span></div>
          </div>

          {view.coverage.warning && <p className="taskadd-error fin-insight-warn" role="status">⚠ {view.coverage.warning}</p>}
          {view.coverage.shortHistory && <p className="sub fin-insight-warn">Limited history — period comparisons may be unreliable.</p>}

          {view.categoryTotals.length > 0 && (
            <div className="fin-insight-block">
              <p className="fin-bill-grouphead">Category breakdown</p>
              <ul className="fin-cat-breakdown">
                {view.categoryTotals.slice(0, 8).map((c) => (
                  <li key={c.categoryId ?? "uncat"} className="fin-cat-bdrow">
                    <span className="fin-cat-bdname">{c.name}</span>
                    <span className="fin-cat-bdbar" aria-hidden><span style={{ width: `${Math.min(100, c.pct)}%` }} /></span>
                    <span className="fin-cat-bdamt">{money(c.total)} <span className="sub">· {c.pct}%{c.change >= 25 ? ` · ▲${money(c.change)}` : c.change <= -25 ? ` · ▼${money(Math.abs(c.change))}` : ""}</span></span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {view.merchantTotals.length > 0 && (
            <div className="fin-insight-block">
              <p className="fin-bill-grouphead">Top merchants</p>
              <ul className="fin-txn-list">
                {view.merchantTotals.slice(0, 5).map((m) => (
                  <li key={m.merchant} className="fin-txn-row">
                    <div className="fin-txn-main"><span className="fin-txn-desc">{m.merchant}</span><span className="fin-txn-amt">{money(m.total)}</span></div>
                    <div className="fin-txn-meta sub"><span>{m.count} transaction{m.count === 1 ? "" : "s"}</span><span aria-hidden>·</span><span>{m.share}% of spending</span>{m.categoryName && (<><span aria-hidden>·</span><span>{m.categoryName}</span></>)}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {view.insights.length > 0 && (
            <div className="fin-insight-block">
              <p className="fin-bill-grouphead">Insights</p>
              <ul className="fin-match-list">
                {view.insights.map((i) => (
                  <li key={i.key} className="fin-match-card">
                    <div className="fin-match-head">
                      <span className="fin-tag sandbox">{i.title}</span>
                      <span className={`fin-tag conf-${i.confidence}`}>{i.confidence} confidence</span>
                    </div>
                    <p className="sub fin-insight-summary">{i.summary}</p>
                    <p className="sub">Evidence: {i.periodStart} to {i.periodEnd}</p>
                    <div className="fin-match-actions">
                      <button type="button" className="linkbtn" onClick={() => setWhy(why === i.key ? null : i.key)}>Why am I seeing this?</button>
                      <button type="button" className="linkbtn" disabled={busy} onClick={() => dismiss(i.key)}>Dismiss</button>
                    </div>
                    {why === i.key && <p className="sub fin-insight-why">{i.why}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {view.opportunities.length > 0 && (
            <div className="fin-insight-block">
              <p className="fin-bill-grouphead">Opportunities</p>
              <ul className="fin-match-list">
                {view.opportunities.map((o) => (
                  <li key={o.key} className="fin-match-card">
                    <div className="fin-match-head"><span className="fin-tag good">Opportunity</span><span className={`fin-tag conf-${o.confidence}`}>{o.confidence} confidence</span></div>
                    <p className="sub"><strong>{o.observation}</strong></p>
                    <p className="sub fin-insight-summary">{o.why}</p>
                    <p className="sub">Estimated upside: {o.upsideLabel}</p>
                    <p className="sub">Next: {o.nextAction}</p>
                    <p className="sub fin-insight-why">Limitation: {o.limitation} · Evidence: {o.evidencePeriod}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {view.insights.length === 0 && view.opportunities.length === 0 && <p className="empty">No notable insights for this period yet.</p>}
        </>
      )}
    </div>
  );
}
