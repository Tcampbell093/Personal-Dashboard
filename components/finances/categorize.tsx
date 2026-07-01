"use client";

/* Finance 1B.5A — Categorize transactions + Categories & merchant rules.
 *
 * A focused review queue (uncategorized + suggested, newest first, bounded to 10)
 * with a category selector + Confirm / Change / Reject. Confirming may optionally
 * create an owner-approved merchant rule (default: Suggest; never auto by default)
 * and optionally apply it to existing uncategorized transactions (unchecked by
 * default). Categorization is descriptive metadata only — it changes no balance,
 * movement, or bank evidence. A management panel edits categories + rules. */

import { useCallback, useEffect, useMemo, useState } from "react";

const PAGE = 10; // bounded review queue
const money = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

interface Category { id: number; name: string; slug: string; kind: string; isSystem: boolean; isActive: boolean; sortOrder: number }
interface QueueTxn {
  transactionId: number; amount: number; date: string | null; description: string; accountLabel: string; isPending: boolean;
  category: { id: number; name: string; kind: string } | null;
  categorySource: string | null; categoryStatus: "suggested" | "confirmed" | null;
  confidence: number | null; confidenceBand: "high" | "medium" | "low" | null; reasonCodes: string[]; explanation: string | null;
}
interface Rule { id: number; name: string; matchType: string; matchValue: string; categoryId: number; categoryName: string; behavior: string; priority: number; isActive: boolean; affects: number }
type Filter = "review" | "uncategorized" | "suggested" | "confirmed" | "all";

const SOURCE_LABEL: Record<string, string> = { owner: "You chose this", merchant_rule: "Merchant rule", deterministic_suggestion: "Suggested" };

export function Categorize({ initialNeedsReview = 0 }: { initialNeedsReview?: number }) {
  const [open, setOpen] = useState(false);
  const [manage, setManage] = useState(false);
  const [queue, setQueue] = useState<QueueTxn[]>([]);
  const [cats, setCats] = useState<Category[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [filter, setFilter] = useState<Filter>("review");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ruleFor, setRuleFor] = useState<number | null>(null); // txn id whose rule dialog is open
  const [newCat, setNewCat] = useState("");

  const loadCats = useCallback(async () => {
    const r = await fetch("/api/finances/categories?includeInactive=true");
    if (r.ok) setCats(((await r.json()) as { categories: Category[] }).categories);
  }, []);
  const loadRules = useCallback(async () => {
    const r = await fetch("/api/finances/categories/rules");
    if (r.ok) setRules(((await r.json()) as { rules: Rule[] }).rules);
  }, []);
  const loadQueue = useCallback(async () => {
    const r = await fetch(`/api/finances/categories/assignments?filter=${filter}&limit=${PAGE}`);
    if (r.ok) setQueue(((await r.json()) as { transactions: QueueTxn[] }).transactions);
  }, [filter]);

  useEffect(() => { if (open) { void loadCats(); void loadQueue(); void loadRules(); } }, [open, loadCats, loadQueue, loadRules]);
  useEffect(() => { if (open) void loadQueue(); }, [filter, open, loadQueue]);

  const activeCats = useMemo(() => cats.filter((c) => c.isActive), [cats]);
  const refreshAll = useCallback(async () => { await Promise.all([loadQueue(), loadRules(), loadCats()]); }, [loadQueue, loadRules, loadCats]);

  const generate = useCallback(async () => {
    setBusy(true); setError(null);
    try { const r = await fetch("/api/finances/categories/suggest", { method: "POST" }); if (!r.ok) setError("Could not generate suggestions."); await refreshAll(); }
    catch { setError("Could not generate suggestions."); } finally { setBusy(false); }
  }, [refreshAll]);

  const confirmCat = useCallback(async (txnId: number, categoryId: number, rule?: { behavior: string; applyToExisting: boolean }) => {
    setBusy(true); setError(null); setRuleFor(null);
    try {
      const body: Record<string, unknown> = { categoryId };
      if (rule) { body.createRule = true; body.ruleBehavior = rule.behavior; body.applyToExisting = rule.applyToExisting; }
      const r = await fetch(`/api/finances/categories/assignments/${txnId}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { const d = (await r.json().catch(() => ({}))) as { error?: string }; setError(d.error ?? "Could not confirm."); }
      await refreshAll();
    } catch { setError("Could not confirm."); } finally { setBusy(false); }
  }, [refreshAll]);

  const reject = useCallback(async (txnId: number) => {
    setBusy(true); setError(null);
    try { await fetch(`/api/finances/categories/assignments/${txnId}/reject`, { method: "POST" }); await refreshAll(); }
    catch { setError("Could not reject."); } finally { setBusy(false); }
  }, [refreshAll]);

  const createCategory = useCallback(async () => {
    if (!newCat.trim()) return; setBusy(true); setError(null);
    try { const r = await fetch("/api/finances/categories", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: newCat.trim() }) }); if (!r.ok) { const d = (await r.json().catch(() => ({}))) as { error?: string }; setError(d.error ?? "Could not create category."); } else setNewCat(""); await loadCats(); }
    catch { setError("Could not create category."); } finally { setBusy(false); }
  }, [newCat, loadCats]);

  const toggleRule = useCallback(async (rule: Rule) => {
    setBusy(true); try { await fetch(`/api/finances/categories/rules/${rule.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ isActive: !rule.isActive }) }); await refreshAll(); } finally { setBusy(false); }
  }, [refreshAll]);
  const ruleBehavior = useCallback(async (rule: Rule, behavior: string) => {
    setBusy(true); try { await fetch(`/api/finances/categories/rules/${rule.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ behavior }) }); await refreshAll(); } finally { setBusy(false); }
  }, [refreshAll]);

  return (
    <div className="fin-imported">
      <div className="fin-imported-actions">
        <button type="button" className="btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "Hide categorization" : `Categorize transactions${initialNeedsReview > 0 ? ` (${initialNeedsReview})` : ""}`}
        </button>
        {open && <button type="button" className="btn" disabled={busy} aria-busy={busy} onClick={generate}>Suggest categories</button>}
        {open && <button type="button" className="linkbtn" onClick={() => setManage((v) => !v)}>{manage ? "Hide" : "Categories & merchant rules"}</button>}
      </div>

      {open && (
        <>
          {error && <p className="taskadd-error" role="alert">{error}</p>}

          {manage && (
            <div className="fin-cat-manage">
              <p className="fin-bill-grouphead">Categories</p>
              <ul className="fin-cat-chiplist">
                {cats.map((c) => (<li key={c.id} className={`fin-tag ${c.isActive ? "" : "muted"}`}>{c.name}{!c.isActive && " (off)"}</li>))}
              </ul>
              <div className="fin-cat-newrow">
                <input className="fin-cat-input" placeholder="New category name" value={newCat} onChange={(e) => setNewCat(e.target.value)} aria-label="New category name" />
                <button type="button" className="linkbtn" disabled={busy || !newCat.trim()} onClick={createCategory}>Add category</button>
              </div>
              <p className="fin-bill-grouphead" style={{ marginTop: 12 }}>Merchant rules</p>
              {rules.length === 0 ? <p className="empty">No merchant rules yet.</p> : (
                <ul className="fin-rule-list">
                  {rules.map((r) => (
                    <li key={r.id} className="fin-rule-row">
                      <span className="fin-rule-main"><strong>{r.matchValue}</strong> → {r.categoryName} <span className="sub">· {r.behavior === "auto" ? "Auto-categorize" : "Suggest"} · affects {r.affects}{!r.isActive && " · disabled"}</span></span>
                      <span className="fin-rule-actions">
                        <button type="button" className="linkbtn" disabled={busy} onClick={() => ruleBehavior(r, r.behavior === "auto" ? "suggest" : "auto")}>{r.behavior === "auto" ? "Make suggest" : "Make auto"}</button>
                        <button type="button" className="linkbtn" disabled={busy} onClick={() => toggleRule(r)}>{r.isActive ? "Disable" : "Enable"}</button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="fin-txn-filters" role="group" aria-label="Category filters">
            {(["review", "uncategorized", "suggested", "confirmed", "all"] as Filter[]).map((f) => (
              <button key={f} type="button" className={`fin-chip ${filter === f ? "on" : ""}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {f === "review" ? "Needs review" : f === "all" ? "All categories" : f[0].toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>

          {queue.length === 0 ? (
            <p className="empty">{filter === "confirmed" ? "No confirmed categories yet." : "Nothing needs categorization."}</p>
          ) : (
            <ul className="fin-match-list">
              {queue.map((t) => (
                <li key={t.transactionId} className="fin-match-card">
                  <div className="fin-txn-main">
                    <span className="fin-txn-desc">{t.description}</span>
                    <span className={`fin-txn-amt ${t.amount >= 0 ? "good" : ""}`}>{money(t.amount)}</span>
                  </div>
                  <div className="fin-txn-meta sub">
                    <span>{t.accountLabel}</span>{t.date && (<><span aria-hidden>·</span><span>{t.date}</span></>)}
                    {t.isPending && (<><span aria-hidden>·</span><span className="fin-tag muted">Pending</span></>)}
                  </div>
                  <div className="fin-cat-state sub">
                    {t.category == null ? (
                      <span className="fin-tag muted">Uncategorized</span>
                    ) : (
                      <>
                        <span className={`fin-tag ${t.categoryStatus === "confirmed" ? "good" : "sandbox"}`}>{t.category.name}</span>
                        <span>{t.categoryStatus === "suggested" ? "Suggested" : SOURCE_LABEL[t.categorySource ?? "owner"]}</span>
                        {t.categoryStatus === "suggested" && t.confidenceBand && <span className={`fin-tag conf-${t.confidenceBand}`}>{t.confidenceBand} confidence</span>}
                      </>
                    )}
                  </div>
                  {t.categoryStatus === "suggested" && t.explanation && <p className="sub fin-match-why">{t.explanation}</p>}

                  <div className="fin-match-actions">
                    <label className="fin-cat-pick">
                      <span className="sub">{t.categoryStatus === "confirmed" ? "Change to" : "Category"}</span>
                      <select aria-label="Category" disabled={busy} defaultValue={t.category?.id ?? ""} onChange={(e) => { const v = Number(e.target.value); if (v) confirmCat(t.transactionId, v); }}>
                        <option value="">Select…</option>
                        {activeCats.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
                      </select>
                    </label>
                    {t.categoryStatus === "suggested" && t.category && (
                      <button type="button" className="btn" disabled={busy} onClick={() => confirmCat(t.transactionId, t.category!.id)}>Confirm</button>
                    )}
                    {t.category && (
                      <button type="button" className="linkbtn" disabled={busy} onClick={() => setRuleFor(ruleFor === t.transactionId ? null : t.transactionId)}>Create rule…</button>
                    )}
                    {t.categoryStatus === "suggested" && (
                      <button type="button" className="linkbtn" disabled={busy} onClick={() => reject(t.transactionId)}>Reject suggestion</button>
                    )}
                  </div>

                  {ruleFor === t.transactionId && t.category && (
                    <RuleDialog merchant={t.description} category={t.category.name} busy={busy}
                      onCancel={() => setRuleFor(null)}
                      onCreate={(behavior, applyToExisting) => confirmCat(t.transactionId, t.category!.id, { behavior, applyToExisting })} />
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="sub fin-txn-count">Showing {queue.length} (max {PAGE}). Use Suggest categories to refresh.</p>
        </>
      )}
    </div>
  );
}

function RuleDialog({ merchant, category, busy, onCancel, onCreate }: { merchant: string; category: string; busy: boolean; onCancel: () => void; onCreate: (behavior: string, applyToExisting: boolean) => void }) {
  const [behavior, setBehavior] = useState("suggest"); // default Suggest, never auto
  const [applyExisting, setApplyExisting] = useState(false); // unchecked by default
  return (
    <div className="fin-match-confirm" role="group" aria-label="Create a merchant rule">
      <p className="sub">Future transactions from “{merchant}” will be {behavior === "auto" ? "automatically categorized" : "suggested"} as <strong>{category}</strong>.</p>
      <div className="fin-cat-ruleopts">
        <label><input type="radio" name="rb" checked={behavior === "suggest"} onChange={() => setBehavior("suggest")} /> Suggest this category for this merchant</label>
        <label><input type="radio" name="rb" checked={behavior === "auto"} onChange={() => setBehavior("auto")} /> Automatically categorize this merchant</label>
        <label><input type="checkbox" checked={applyExisting} onChange={(e) => setApplyExisting(e.target.checked)} /> Apply to existing uncategorized transactions from this merchant</label>
      </div>
      <div className="fin-match-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => onCreate(behavior, applyExisting)}>Create rule</button>
        <button type="button" className="linkbtn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
