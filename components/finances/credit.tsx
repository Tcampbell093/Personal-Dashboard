"use client";

/* Finance 1C.0A — Credit & financial health (manual, read-only guidance).
 *
 * All data is owner-entered. Xanther does NOT connect to a credit bureau or
 * Credit Karma, never files disputes, never applies for credit, never moves
 * money, and makes no guaranteed score-improvement claim. Every guidance card
 * separates observation, why, next step, cash required, timing, tradeoff, and
 * required verification. Score sources are never averaged together.
 *
 * Each record type has an Add form AND an inline Edit form (PATCH); scores can be
 * deleted and accounts deleted/archived. Every API error is surfaced to the user
 * rather than silently closing or doing nothing. */

import { useCallback, useEffect, useState } from "react";

const money = (n: number | null | undefined) => (n == null ? "—" : `$${Math.abs(Math.round(n)).toLocaleString("en-US")}`);
const pct = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(n)}%`);

type Conf = string;
interface Score { id: number; score: number; source: string; bureau: string | null; scoringModel: string | null; asOfDate: string; notes: string | null }
interface Trend { source: string; scoringModel: string | null; latest: number; latestDate: string; prior: number | null; priorDate: string | null; change: number | null }
interface Account { id: number; accountType: string; name: string; issuer: string | null; status: string; isRevolving: boolean; creditLimit: string | null; currentBalance: string; minimumPayment: string | null; paymentDueDate: string | null; isAuthorizedUser: boolean }
interface Collection { id: number; collectorName: string; originalCreditor: string | null; reportedBalance: string; status: string; validationStatus: string; settlementOffer: string | null; dateReported: string | null }
interface Inquiry { id: number; creditorName: string; inquiryDate: string; bureau: string | null; inquiryType: string; purpose: string | null }
interface Late { id: number; creditAccountId: number; daysLate: number; reportedDate: string; status: string; amountPastDue: string | null }
interface Goal { id: number; goalType: string; targetValue: string; targetDate: string | null; status: string; priority: string }
interface Util { aggregatePct: number | null; totalBalance: number; totalLimit: number; perAccount: { id: number; name: string; utilizationPct: number; balance: number; limit: number; isAuthorizedUser: boolean }[]; toReach: { threshold: number; amount: number }[]; missingLimitCount: number; authorizedUserCount: number; note: string }
interface Observation { key: string; type: string; title: string; summary: string; evidence: string; confidence: Conf; source: string | null; limitation: string; asOfDate: string | null }
interface Action { key: string; title: string; observation: string; why: string; nextStep: string; estimatedCost: number | null; timing: string; tradeoff: string; verificationNeeded: string; confidence: Conf; urgency: string; estimatedUpside: string; riskLevel: string; professionalVerificationRecommended: boolean }
interface GoalProgress { id: number; goalType: string; targetValue: number; currentValue: number | null; progressPct: number | null; status: string; onTrack: boolean | null }
interface Overview {
  scores: Score[]; trends: Trend[]; multiSourceWarning: string | null;
  accounts: Account[]; utilization: Util;
  collections: Collection[]; collectionsSummary: { activeCount: number; activeBalance: number; smallestActiveBalance: number | null; oldestActiveDate: string | null; unresolvedCount: number; reviewCount: number };
  inquiries: Inquiry[]; inquirySummary: { hardCount: number; softCount: number; recentHardCount: number };
  latePayments: Late[]; latePaymentCount: number;
  goals: Goal[]; goalProgress: GoalProgress[];
  history: { oldestOpenDate: string | null; averageOpenAgeMonths: number | null; openRevolvingCount: number; installmentCount: number; derogatoryCount: number; latePaymentCount: number; recentHardInquiryCount: number; totalOpenAccounts: number; incomplete: boolean };
  observations: Observation[]; actions: Action[];
  health: { sections: { key: string; label: string; status: string; detail: string }[]; overall: string; overallReasons: string[] };
  cashFlow: { available: number | null; nextPaydayDate: string | null; ok: boolean };
  dataQuality: string[]; staleScore: boolean; disclaimer: string;
}

type Tab = "overview" | "profile" | "goals" | "guidance";
const SOURCES = ["experian", "equifax", "transunion", "credit_karma", "bank", "lender", "other"];
const ACCT_TYPES = ["credit_card", "secured_card", "auto_loan", "personal_loan", "student_loan", "mortgage", "retail_card", "other"];
const ACCT_STATUSES = ["open", "closed", "charged_off", "delinquent", "unknown"];
const VAL_STATUSES = ["not_requested", "requested", "received", "incomplete", "verified_by_owner"];
const COLL_STATUSES = ["reported", "disputed", "validated", "settled", "paid", "removed", "unknown"];
const LATE_STATUSES = ["reported", "resolved", "disputed", "removed"];
const GOAL_TYPES = ["score_target", "utilization_target", "collection_resolution", "on_time_payment_streak", "debt_balance_target"];
const GOAL_STATUSES = ["active", "achieved", "paused", "abandoned"];
const conf = (c: string) => <span className={`fin-tag conf-${c}`}>{c} confidence</span>;

/** Fetch helper that surfaces the server's error message instead of failing silently. */
async function send(url: string, method: "POST" | "PATCH" | "DELETE", body?: unknown): Promise<{ ok: boolean; error: string | null; data: unknown }> {
  try {
    const r = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    let data: unknown = null; try { data = await r.json(); } catch { /* empty body */ }
    if (r.ok) return { ok: true, error: null, data };
    const err = (data as { error?: string })?.error ?? `Request failed (${r.status}).`;
    return { ok: false, error: err, data };
  } catch { return { ok: false, error: "Network error — please try again.", data: null }; }
}

export function CreditHealth() {
  const [view, setView] = useState<Overview | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");

  const load = useCallback(async () => {
    try { const r = await fetch("/api/finances/credit"); if (r.ok) setView((await r.json()) as Overview); }
    catch { /* keep */ } finally { setLoaded(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (!loaded) return <div className="fin-empty">Loading credit &amp; financial health…</div>;
  if (!view) return <div className="fin-empty">Credit &amp; financial health is temporarily unavailable.</div>;

  return (
    <div className="fin-credit">
      <p className="fin-credit-manual">⚠ This credit information is manually entered and may become outdated. Xanther does not connect to a credit bureau or Credit Karma, and gives educational guidance only — not financial, legal, or credit-repair advice.</p>
      {view.multiSourceWarning && <p className="fin-credit-note">{view.multiSourceWarning}</p>}
      {view.staleScore && <p className="fin-credit-warn">⚠ Your most recent score is over 45 days old — consider updating it.</p>}

      <div className="fin-tabs" role="tablist">
        {(["overview", "profile", "goals", "guidance"] as Tab[]).map((t) => (
          <button key={t} className={`fin-tab${tab === t ? " on" : ""}`} onClick={() => setTab(t)}>
            {t === "overview" ? "Overview" : t === "profile" ? "Credit profile" : t === "goals" ? "Goals" : "Guidance"}
          </button>
        ))}
      </div>

      {tab === "overview" && <OverviewTab view={view} />}
      {tab === "profile" && <ProfileTab view={view} reload={load} />}
      {tab === "goals" && <GoalsTab view={view} reload={load} />}
      {tab === "guidance" && <GuidanceTab view={view} />}
    </div>
  );
}

/* ------------------------------------------------------------- Overview -- */
function OverviewTab({ view }: { view: Overview }) {
  return (
    <div className="fin-credit-body">
      <div className="fin-stat-row">
        <div className="fin-stat"><span className="fin-stat-k">Aggregate revolving utilization</span><span className="fin-stat-v num">{pct(view.utilization.aggregatePct)}</span></div>
        <div className="fin-stat"><span className="fin-stat-k">Active collections</span><span className="fin-stat-v num">{view.collectionsSummary.activeCount} · {money(view.collectionsSummary.activeBalance)}</span></div>
        <div className="fin-stat"><span className="fin-stat-k">Recent hard inquiries</span><span className="fin-stat-v num">{view.inquirySummary.recentHardCount}</span></div>
      </div>

      <h4 className="fin-credit-h">Latest score by source</h4>
      {view.trends.length === 0 ? <p className="fin-empty">No score entered yet.</p> : (
        <ul className="fin-credit-list">
          {view.trends.map((t) => (
            <li key={`${t.source}|${t.scoringModel}`} className="fin-credit-score">
              <span className="fin-score-num num">{t.latest}</span>
              <span className="fin-score-src">{t.source}{t.scoringModel ? ` · ${t.scoringModel}` : ""} · as of {t.latestDate}</span>
              {t.change != null && <span className={`fin-score-chg ${t.change >= 0 ? "up" : "down"}`}>{t.change >= 0 ? "▲" : "▼"} {Math.abs(t.change)} pts since {t.priorDate} (same source)</span>}
            </li>
          ))}
        </ul>
      )}
      {view.multiSourceWarning && <p className="fin-credit-note">{view.multiSourceWarning}</p>}

      <h4 className="fin-credit-h">Overall financial health — {view.health.overall}</h4>
      <ul className="fin-health-grid">
        {view.health.sections.map((s) => (
          <li key={s.key} className={`fin-health-cell h-${s.status}`}>
            <span className="fin-health-label">{s.label}</span>
            <span className="fin-health-status">{s.status === "good" ? "Good" : s.status === "attention" ? "Needs attention" : "Insufficient data"}</span>
            <span className="fin-health-detail">{s.detail}</span>
          </li>
        ))}
      </ul>

      <h4 className="fin-credit-h">Upcoming credit payments</h4>
      {view.accounts.filter((a) => a.status === "open" && a.paymentDueDate).length === 0 ? <p className="fin-empty">No upcoming payment dates entered.</p> : (
        <ul className="fin-credit-list">
          {view.accounts.filter((a) => a.status === "open" && a.paymentDueDate).sort((a, b) => (a.paymentDueDate! < b.paymentDueDate! ? -1 : 1)).map((a) => (
            <li key={a.id} className="fin-credit-row"><span>{a.name}</span><span className="num">due {a.paymentDueDate}{a.minimumPayment ? ` · min ${money(Number(a.minimumPayment))}` : ""}</span></li>
          ))}
        </ul>
      )}

      <h4 className="fin-credit-h">Current goals</h4>
      {view.goalProgress.length === 0 ? <p className="fin-empty">No goals yet.</p> : (
        <ul className="fin-credit-list">
          {view.goalProgress.map((g) => (
            <li key={g.id} className="fin-credit-row"><span>{g.goalType.replace(/_/g, " ")} → {g.targetValue}</span><span className="num">{g.progressPct != null ? `${Math.round(g.progressPct)}%` : "—"}{g.onTrack != null ? (g.onTrack ? " · on track" : " · behind") : ""}</span></li>
          ))}
        </ul>
      )}

      <h4 className="fin-credit-h">Top actions</h4>
      <ActionList actions={view.actions.slice(0, 3)} />

      {view.dataQuality.length > 0 && (
        <div className="fin-credit-dq">
          <span className="fin-credit-dq-h">Data quality</span>
          <ul>{view.dataQuality.map((d, i) => <li key={i}>{d}</li>)}</ul>
        </div>
      )}
      <p className="fin-credit-disclaimer">{view.disclaimer}</p>
    </div>
  );
}

/* -------------------------------------------------------------- Profile -- */
function ProfileTab({ view, reload }: { view: Overview; reload: () => Promise<void> }) {
  return (
    <div className="fin-credit-body">
      <EntityPanel<Score>
        title="Scores" base="/api/finances/credit/scores" items={view.scores} reload={reload}
        summary={(s) => `${s.score} · ${s.source}${s.scoringModel ? ` (${s.scoringModel})` : ""} · as of ${s.asOfDate}`}
        renderForm={(rec, done) => <ScoreForm record={rec} done={done} />}
        deletable />
      <EntityPanel<Account>
        title="Accounts, limits &amp; balances" base="/api/finances/credit/accounts" items={view.accounts} reload={reload}
        summary={(a) => `${a.name} · ${a.accountType.replace(/_/g, " ")}${a.isRevolving ? " · revolving" : ""}${a.isAuthorizedUser ? " · authorized user" : ""} · ${a.status} — ${money(Number(a.currentBalance))}${a.creditLimit ? ` / ${money(Number(a.creditLimit))}` : " (no limit)"}`}
        renderForm={(rec, done) => <AccountForm record={rec} done={done} />}
        deletable deleteLabel="Delete / archive" archiveable />
      <div className="fin-credit-sub">
        <span className="fin-credit-dq-h">Revolving utilization</span>
        <p className="num">Aggregate {pct(view.utilization.aggregatePct)} — {money(view.utilization.totalBalance)} of {money(view.utilization.totalLimit)}{view.utilization.missingLimitCount ? ` · ${view.utilization.missingLimitCount} missing limit` : ""}{view.utilization.authorizedUserCount ? ` · ${view.utilization.authorizedUserCount} authorized-user` : ""}</p>
        <ul className="fin-credit-list">{view.utilization.toReach.map((t) => <li key={t.threshold} className="fin-credit-row"><span>To reach below {t.threshold}%</span><span className="num">{money(t.amount)}</span></li>)}</ul>
        <p className="fin-credit-note">{view.utilization.note}</p>
      </div>
      <EntityPanel<Collection>
        title="Collections" base="/api/finances/credit/collections" items={view.collections} reload={reload}
        summary={(c) => `${c.collectorName}${c.originalCreditor ? ` (orig. ${c.originalCreditor})` : ""} · ${c.status} · ${c.validationStatus.replace(/_/g, " ")} — ${money(Number(c.reportedBalance))}`}
        renderForm={(rec, done) => <CollectionForm record={rec} done={done} />} />
      <p className="fin-credit-note">Collections summary: {view.collectionsSummary.activeCount} active · {money(view.collectionsSummary.activeBalance)} · smallest {money(view.collectionsSummary.smallestActiveBalance)} · {view.collectionsSummary.reviewCount} need review. Do not decide solely by smallest balance — verify each debt first.</p>
      <EntityPanel<Inquiry>
        title="Inquiries" base="/api/finances/credit/inquiries" items={view.inquiries} reload={reload}
        summary={(i) => `${i.creditorName} · ${i.inquiryType}${i.bureau ? ` · ${i.bureau}` : ""} · ${i.inquiryDate}`}
        renderForm={(rec, done) => <InquiryForm record={rec} done={done} />} />
      <p className="fin-credit-note">Inquiry summary: {view.inquirySummary.hardCount} hard · {view.inquirySummary.softCount} soft · {view.inquirySummary.recentHardCount} hard in last 6 months. Only hard inquiries influence guidance.</p>
      <EntityPanel<Late>
        title="Late-payment records" base="/api/finances/credit/late-payments" items={view.latePayments} reload={reload}
        summary={(l) => `${view.accounts.find((a) => a.id === l.creditAccountId)?.name ?? `account #${l.creditAccountId}`} · ${l.daysLate} days late · ${l.status} · ${l.reportedDate}`}
        renderForm={(rec, done) => <LateForm record={rec} accounts={view.accounts} done={done} />} />
    </div>
  );
}

/* ---------------------------------------------------------------- Goals -- */
function GoalsTab({ view, reload }: { view: Overview; reload: () => Promise<void> }) {
  const progressOf = (id: number) => view.goalProgress.find((g) => g.id === id);
  return (
    <div className="fin-credit-body">
      <EntityPanel<Goal>
        title="Credit goals" base="/api/finances/credit/goals" items={view.goals} reload={reload}
        summary={(g) => { const p = progressOf(g.id); return `${g.goalType.replace(/_/g, " ")} → ${g.targetValue} · ${g.status}${p?.progressPct != null ? ` · ${Math.round(p.progressPct)}%` : ""}${p?.onTrack != null ? (p.onTrack ? " · on track" : " · behind") : ""}`; }}
        renderForm={(rec, done) => <GoalForm record={rec} done={done} />} />
      <p className="fin-credit-note">Goal types: score target, utilization target, collection resolution, on-time payment streak, debt balance target.</p>
    </div>
  );
}

/* ------------------------------------------------------------- Guidance -- */
function GuidanceTab({ view }: { view: Overview }) {
  return (
    <div className="fin-credit-body">
      <h4 className="fin-credit-h">What Xanther noticed</h4>
      {view.observations.length === 0 ? <p className="fin-empty">No observations yet — add score, accounts, and collections to enable guidance.</p> : (
        <ul className="fin-credit-obs">
          {view.observations.map((o) => (
            <li key={o.key} className="fin-obs-card">
              <div className="fin-obs-head"><span className="fin-obs-title">{o.title}</span>{conf(o.confidence)}</div>
              <p className="fin-obs-summary">{o.summary}</p>
              <p className="fin-obs-meta">Evidence: {o.evidence}{o.source ? ` · source: ${o.source}` : ""}{o.asOfDate ? ` · as of ${o.asOfDate}` : ""}</p>
              <p className="fin-obs-limit">Limitation: {o.limitation}</p>
            </li>
          ))}
        </ul>
      )}
      <h4 className="fin-credit-h">Priority actions</h4>
      <ActionList actions={view.actions} />
    </div>
  );
}

function ActionList({ actions }: { actions: Action[] }) {
  if (actions.length === 0) return <p className="fin-empty">No action cards yet.</p>;
  return (
    <ul className="fin-credit-actions">
      {actions.map((a) => (
        <li key={a.key} className="fin-action-card">
          <div className="fin-obs-head"><span className="fin-obs-title">{a.title}</span><span className={`fin-urg u-${a.urgency}`}>{a.urgency}</span>{conf(a.confidence)}</div>
          <p className="fin-obs-summary">{a.observation}</p>
          <p className="fin-action-line"><b>Why it matters:</b> {a.why}</p>
          <p className="fin-action-line"><b>Next step:</b> {a.nextStep}</p>
          <p className="fin-action-line"><b>Cash required:</b> {a.estimatedCost != null ? money(a.estimatedCost) : "not applicable"} · <b>Timing:</b> {a.timing}</p>
          <p className="fin-action-line"><b>Tradeoff:</b> {a.tradeoff}</p>
          <p className="fin-action-line"><b>Verification needed:</b> {a.verificationNeeded}{a.professionalVerificationRecommended ? " · professional verification recommended" : ""}</p>
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------- generic add/edit/delete panel */
function EntityPanel<T extends { id: number }>({ title, base, items, reload, summary, renderForm, deletable, deleteLabel, archiveable }: {
  title: string; base: string; items: T[]; reload: () => Promise<void>;
  summary: (item: T) => string; renderForm: (record: T | undefined, done: () => void) => React.ReactNode;
  deletable?: boolean; deleteLabel?: string; archiveable?: boolean;
}) {
  const [mode, setMode] = useState<{ kind: "add" } | { kind: "edit"; id: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const done = () => { setMode(null); setNotice(null); void reload(); };
  const del = async (id: number) => {
    setBusyId(id); setNotice(null);
    const r = await send(`${base}/${id}`, "DELETE");
    setBusyId(null);
    if (!r.ok) { setNotice(r.error); return; }
    if (archiveable && (r.data as { archived?: boolean })?.archived) { setNotice("Account had late-payment history, so it was archived (status set to closed) rather than deleted."); void reload(); return; }
    void reload();
  };
  return (
    <div className="fin-credit-panel">
      <div className="fin-credit-panel-head">
        <span className="fin-credit-dq-h" dangerouslySetInnerHTML={{ __html: title }} />
        <button className="fin-mini-btn" onClick={() => { setNotice(null); setMode(mode?.kind === "add" ? null : { kind: "add" }); }}>{mode?.kind === "add" ? "Cancel" : "+ Add"}</button>
      </div>
      {notice && <p className="fin-credit-warn" role="alert">{notice}</p>}
      {mode?.kind === "add" && <div className="fin-credit-form">{renderForm(undefined, done)}</div>}
      <ul className="fin-credit-list">
        {items.map((it) => mode?.kind === "edit" && mode.id === it.id ? (
          <li key={it.id} className="fin-credit-form">{renderForm(it, done)}</li>
        ) : (
          <li key={it.id} className="fin-credit-row">
            <span>{summary(it)}</span>
            <span className="fin-row-actions">
              <button className="fin-mini-btn" aria-label="Edit" onClick={() => { setNotice(null); setMode({ kind: "edit", id: it.id }); }}>Edit</button>
              {deletable && <button className="fin-mini-btn" aria-label="Delete" disabled={busyId === it.id} onClick={() => void del(it.id)}>{deleteLabel ?? "Delete"}</button>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------- forms ---- */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="fin-field"><span>{label}</span>{children}</label>;
}
/** Submit an add (POST base) or edit (PATCH base/id); surface the server error. */
function useSubmit(base: string, id: number | undefined, done: () => void) {
  const [err, setErr] = useState<string | null>(null);
  const submit = async (body: unknown) => {
    setErr(null);
    const r = await send(id ? `${base}/${id}` : base, id ? "PATCH" : "POST", body);
    if (r.ok) done(); else setErr(r.error);
  };
  return { err, submit };
}

function ScoreForm({ record, done }: { record?: Score; done: () => void }) {
  const [f, setF] = useState({ score: record ? String(record.score) : "", source: record?.source ?? "experian", scoringModel: record?.scoringModel ?? "", asOfDate: record?.asOfDate ?? "" });
  const { err, submit } = useSubmit("/api/finances/credit/scores", record?.id, done);
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit({ ...f, score: Number(f.score), scoringModel: f.scoringModel || null }); }}>
      <Row label="Score"><input type="number" required value={f.score} onChange={(e) => setF({ ...f, score: e.target.value })} /></Row>
      <Row label="Source"><select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>{SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}</select></Row>
      <Row label="Scoring model (optional)"><input value={f.scoringModel} onChange={(e) => setF({ ...f, scoringModel: e.target.value })} placeholder="e.g. FICO 8" /></Row>
      <Row label="As-of date"><input type="date" required value={f.asOfDate} onChange={(e) => setF({ ...f, asOfDate: e.target.value })} /></Row>
      {err && <p className="fin-credit-warn" role="alert">{err}</p>}
      <button className="fin-mini-btn" type="submit">Save score</button>
    </form>
  );
}
function AccountForm({ record, done }: { record?: Account; done: () => void }) {
  const [f, setF] = useState({ name: record?.name ?? "", accountType: record?.accountType ?? "credit_card", isRevolving: record?.isRevolving ?? true, creditLimit: record?.creditLimit ?? "", currentBalance: record?.currentBalance ?? "", minimumPayment: record?.minimumPayment ?? "", paymentDueDate: record?.paymentDueDate ?? "", isAuthorizedUser: record?.isAuthorizedUser ?? false, status: record?.status ?? "open" });
  const { err, submit } = useSubmit("/api/finances/credit/accounts", record?.id, done);
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit({ ...f, creditLimit: f.creditLimit || null, currentBalance: f.currentBalance || 0, minimumPayment: f.minimumPayment || null, paymentDueDate: f.paymentDueDate || null }); }}>
      <Row label="Name"><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Row>
      <Row label="Type"><select value={f.accountType} onChange={(e) => setF({ ...f, accountType: e.target.value })}>{ACCT_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}</select></Row>
      <Row label="Status"><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>{ACCT_STATUSES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}</select></Row>
      <Row label="Revolving"><input type="checkbox" checked={f.isRevolving} onChange={(e) => setF({ ...f, isRevolving: e.target.checked })} /></Row>
      <Row label="Credit limit"><input type="number" value={f.creditLimit} onChange={(e) => setF({ ...f, creditLimit: e.target.value })} /></Row>
      <Row label="Current balance"><input type="number" value={f.currentBalance} onChange={(e) => setF({ ...f, currentBalance: e.target.value })} /></Row>
      <Row label="Minimum payment"><input type="number" value={f.minimumPayment} onChange={(e) => setF({ ...f, minimumPayment: e.target.value })} /></Row>
      <Row label="Payment due date"><input type="date" value={f.paymentDueDate} onChange={(e) => setF({ ...f, paymentDueDate: e.target.value })} /></Row>
      <Row label="Authorized user"><input type="checkbox" checked={f.isAuthorizedUser} onChange={(e) => setF({ ...f, isAuthorizedUser: e.target.checked })} /></Row>
      {err && <p className="fin-credit-warn" role="alert">{err}</p>}
      <button className="fin-mini-btn" type="submit">Save account</button>
    </form>
  );
}
function CollectionForm({ record, done }: { record?: Collection; done: () => void }) {
  const [f, setF] = useState({ collectorName: record?.collectorName ?? "", originalCreditor: record?.originalCreditor ?? "", reportedBalance: record?.reportedBalance ?? "", status: record?.status ?? "reported", validationStatus: record?.validationStatus ?? "not_requested", settlementOffer: record?.settlementOffer ?? "" });
  const { err, submit } = useSubmit("/api/finances/credit/collections", record?.id, done);
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit({ ...f, reportedBalance: f.reportedBalance || 0, originalCreditor: f.originalCreditor || null, settlementOffer: f.settlementOffer || null }); }}>
      <Row label="Collector"><input required value={f.collectorName} onChange={(e) => setF({ ...f, collectorName: e.target.value })} /></Row>
      <Row label="Original creditor"><input value={f.originalCreditor} onChange={(e) => setF({ ...f, originalCreditor: e.target.value })} /></Row>
      <Row label="Reported balance"><input type="number" value={f.reportedBalance} onChange={(e) => setF({ ...f, reportedBalance: e.target.value })} /></Row>
      <Row label="Status"><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>{COLL_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</select></Row>
      <Row label="Validation status"><select value={f.validationStatus} onChange={(e) => setF({ ...f, validationStatus: e.target.value })}>{VAL_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}</select></Row>
      <Row label="Settlement offer (optional)"><input type="number" value={f.settlementOffer} onChange={(e) => setF({ ...f, settlementOffer: e.target.value })} /></Row>
      {err && <p className="fin-credit-warn" role="alert">{err}</p>}
      <button className="fin-mini-btn" type="submit">Save collection</button>
      <p className="fin-credit-note">Verify the debt and obtain written terms before deciding whether to pay.</p>
    </form>
  );
}
function InquiryForm({ record, done }: { record?: Inquiry; done: () => void }) {
  const [f, setF] = useState({ creditorName: record?.creditorName ?? "", inquiryDate: record?.inquiryDate ?? "", inquiryType: record?.inquiryType ?? "hard", bureau: record?.bureau ?? "" });
  const { err, submit } = useSubmit("/api/finances/credit/inquiries", record?.id, done);
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit({ ...f, bureau: f.bureau || null }); }}>
      <Row label="Creditor"><input required value={f.creditorName} onChange={(e) => setF({ ...f, creditorName: e.target.value })} /></Row>
      <Row label="Date"><input type="date" required value={f.inquiryDate} onChange={(e) => setF({ ...f, inquiryDate: e.target.value })} /></Row>
      <Row label="Type"><select value={f.inquiryType} onChange={(e) => setF({ ...f, inquiryType: e.target.value })}>{["hard", "soft"].map((t) => <option key={t} value={t}>{t}</option>)}</select></Row>
      {err && <p className="fin-credit-warn" role="alert">{err}</p>}
      <button className="fin-mini-btn" type="submit">Save inquiry</button>
    </form>
  );
}
function LateForm({ record, accounts, done }: { record?: Late; accounts: Account[]; done: () => void }) {
  const [f, setF] = useState({ creditAccountId: record ? String(record.creditAccountId) : "", daysLate: record ? String(record.daysLate) : "30", reportedDate: record?.reportedDate ?? "", status: record?.status ?? "reported", amountPastDue: record?.amountPastDue ?? "" });
  const { err, submit } = useSubmit("/api/finances/credit/late-payments", record?.id, done);
  const editing = !!record;
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(editing ? { daysLate: Number(f.daysLate), reportedDate: f.reportedDate, status: f.status, amountPastDue: f.amountPastDue || null } : { creditAccountId: Number(f.creditAccountId), daysLate: Number(f.daysLate), reportedDate: f.reportedDate, status: f.status }); }}>
      <Row label="Account">{editing ? <input disabled value={accounts.find((a) => a.id === record!.creditAccountId)?.name ?? `#${record!.creditAccountId}`} /> : <select required value={f.creditAccountId} onChange={(e) => setF({ ...f, creditAccountId: e.target.value })}><option value="">Select…</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>}</Row>
      <Row label="Days late"><input type="number" required value={f.daysLate} onChange={(e) => setF({ ...f, daysLate: e.target.value })} /></Row>
      <Row label="Reported date"><input type="date" required value={f.reportedDate} onChange={(e) => setF({ ...f, reportedDate: e.target.value })} /></Row>
      <Row label="Status"><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>{LATE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</select></Row>
      {err && <p className="fin-credit-warn" role="alert">{err}</p>}
      <button className="fin-mini-btn" type="submit">Save late-payment record</button>
    </form>
  );
}
function GoalForm({ record, done }: { record?: Goal; done: () => void }) {
  const [f, setF] = useState({ goalType: record?.goalType ?? "score_target", targetValue: record ? record.targetValue : "", targetDate: record?.targetDate ?? "", priority: record?.priority ?? "medium", status: record?.status ?? "active" });
  const { err, submit } = useSubmit("/api/finances/credit/goals", record?.id, done);
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit({ ...f, targetValue: Number(f.targetValue), targetDate: f.targetDate || null }); }}>
      <Row label="Goal type"><select value={f.goalType} onChange={(e) => setF({ ...f, goalType: e.target.value })}>{GOAL_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}</select></Row>
      <Row label="Target value"><input type="number" required value={f.targetValue} onChange={(e) => setF({ ...f, targetValue: e.target.value })} /></Row>
      <Row label="Target date (optional)"><input type="date" value={f.targetDate} onChange={(e) => setF({ ...f, targetDate: e.target.value })} /></Row>
      <Row label="Priority"><select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{["low", "medium", "high"].map((p) => <option key={p} value={p}>{p}</option>)}</select></Row>
      {record && <Row label="Status"><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>{GOAL_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</select></Row>}
      {err && <p className="fin-credit-warn" role="alert">{err}</p>}
      <button className="fin-mini-btn" type="submit">Save goal</button>
    </form>
  );
}
