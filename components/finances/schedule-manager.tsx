"use client";

/* Recurring income schedule management for /finances (Finance 1A.4).
 *
 * A schedule is the reusable payday rule; its occurrences are generated into the
 * Income section below. Estimated amounts are always labeled as estimates — the
 * UI never implies certainty, payroll certainty, or bank/employer verification. */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { IncomeScheduleView } from "@/lib/types";

type AccountOption = { id: number; name: string; linked: boolean };

const CADENCES = [
  { v: "weekly", label: "Weekly" },
  { v: "biweekly", label: "Every 2 weeks" },
  { v: "semimonthly", label: "Twice monthly" },
  { v: "monthly", label: "Monthly" },
  { v: "one_time", label: "One-time" },
];
const CADENCE_LABEL: Record<string, string> = Object.fromEntries(CADENCES.map((c) => [c.v, c.label]));
const ESTIMATES = [
  { v: "fixed", label: "Fixed estimate" },
  { v: "typical", label: "Typical estimate" },
  { v: "range", label: "Range" },
  { v: "unknown", label: "Amount unknown" },
];
export const ESTIMATE_LABEL: Record<string, string> = {
  fixed: "Estimated",
  typical: "Estimated (typical)",
  range: "Estimated range",
  unknown: "Amount unknown",
};

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
function shortDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso.slice(0, 10) + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
async function readError(res: Response): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  return data?.error ?? `Request failed (${res.status}).`;
}

interface Draft {
  source: string; cadence: string; anchorDate: string; estimateType: string;
  expectedAmount: string; expectedMin: string; expectedMax: string;
  destinationAccountId: string; dayOfMonth: string; dayA: string; dayB: string;
  endDate: string; isPayday: boolean;
}
const EMPTY: Draft = {
  source: "", cadence: "biweekly", anchorDate: "", estimateType: "typical",
  expectedAmount: "", expectedMin: "", expectedMax: "", destinationAccountId: "",
  dayOfMonth: "", dayA: "1", dayB: "15", endDate: "", isPayday: true,
};

export function ScheduleManager({
  schedules,
  accounts,
}: {
  schedules: IncomeScheduleView[];
  accounts: AccountOption[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const nameOf = (id: number | null) => (id == null ? null : accounts.find((a) => a.id === id)?.name ?? `#${id}`);

  async function mutate(url: string, init: RequestInit): Promise<boolean> {
    setError(null);
    const res = await fetch(url, init);
    if (!res.ok) { setError(await readError(res)); return false; }
    startTransition(() => router.refresh());
    return true;
  }
  const send = (url: string, method: string, body?: unknown) =>
    mutate(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });

  function estimateSummary(s: IncomeScheduleView): string {
    if (s.estimateType === "unknown") return "Amount unknown";
    if (s.estimateType === "range") return `${money(s.expectedMin ?? 0)}–${money(s.expectedMax ?? 0)} (est.)`;
    return `${money(s.expectedAmount)} (est.)`;
  }
  function destSummary(s: IncomeScheduleView): string {
    if (s.allocations.length) return `Split across ${s.allocations.length} accounts`;
    if (s.destinationAccountId != null) return `To ${nameOf(s.destinationAccountId)}`;
    return "Destination not assigned";
  }

  return (
    <div className="fin-schedules">
      {schedules.length === 0 && <div className="empty">No recurring income yet. Add a paycheck schedule below.</div>}

      {schedules.map((s) =>
        editingId === s.id ? (
          <ScheduleForm key={s.id} initial={toDraft(s)} accounts={accounts} pending={pending}
            submitLabel="Save schedule" onCancel={() => setEditingId(null)}
            onSubmit={async (d) => { if (await send(`/api/finances/income-schedules/${s.id}`, "PATCH", serialize(d))) setEditingId(null); }} />
        ) : (
          <div className={`fin-sched-row${s.active ? "" : " inactive"}`} key={s.id}>
            <div>
              <div className="main">
                {s.source} <span className="fin-tag muted">{CADENCE_LABEL[s.cadence] ?? s.cadence}</span>
                {s.isPayday && <span className="fin-tag good">Payday</span>}
                {!s.active && <span className="fin-tag muted">Paused</span>}
              </div>
              <div className="sub">
                {estimateSummary(s)} · {destSummary(s)} · next {shortDate(s.nextDate)}
                {s.endDate ? ` · ends ${shortDate(s.endDate)}` : ""}
              </div>
            </div>
            <div className="fin-bill-right">
              <button className="linkbtn" disabled={pending} onClick={() => { setEditingId(s.id); setAdding(false); }}>Edit</button>
              <button className="linkbtn" disabled={pending}
                onClick={() => send(`/api/finances/income-schedules/${s.id}`, "PATCH", { active: !s.active })}>
                {s.active ? "Pause" : "Resume"}
              </button>
              <button className="linkbtn danger" disabled={pending}
                onClick={() => { if (confirm(`Archive the “${s.source}” schedule? It stops generating new paychecks; every existing occurrence and its income history are kept. (A schedule with no history is removed outright.)`)) send(`/api/finances/income-schedules/${s.id}`, "DELETE"); }}>
                Archive
              </button>
            </div>
          </div>
        ),
      )}

      {adding ? (
        <ScheduleForm initial={EMPTY} accounts={accounts} pending={pending}
          submitLabel="Add schedule" onCancel={() => setAdding(false)}
          onSubmit={async (d) => { if (await send("/api/finances/income-schedules", "POST", serialize(d))) setAdding(false); }} />
      ) : (
        <button className="btn" disabled={pending} onClick={() => { setAdding(true); setEditingId(null); }}>+ Add recurring income</button>
      )}

      <div className="fin-form-note">
        These are <b>estimated</b> paychecks. The amount stays an estimate until you
        receive each occurrence below — nothing here is verified by a bank or employer yet.
      </div>
      {error && <div className="taskadd-error">{error}</div>}
    </div>
  );
}

function ScheduleForm({
  initial, accounts, pending, submitLabel, onSubmit, onCancel,
}: {
  initial: Draft; accounts: AccountOption[]; pending: boolean; submitLabel: string;
  onSubmit: (d: Draft) => void; onCancel: () => void;
}) {
  const [d, setD] = useState<Draft>(initial);
  const set = (p: Partial<Draft>) => setD((prev) => ({ ...prev, ...p }));
  return (
    <form className="fin-acct-form" onSubmit={(e) => { e.preventDefault(); if (d.source.trim() && d.anchorDate) onSubmit({ ...d, source: d.source.trim() }); }}>
      <div className="fin-form-row">
        <label className="fin-field"><span>Source / employer</span>
          <input value={d.source} onChange={(e) => set({ source: e.target.value })} placeholder="e.g. SwagUp" disabled={pending} /></label>
        <label className="fin-field"><span>Cadence</span>
          <select value={d.cadence} onChange={(e) => set({ cadence: e.target.value })} disabled={pending}>
            {CADENCES.map((c) => <option key={c.v} value={c.v}>{c.label}</option>)}
          </select></label>
        <label className="fin-field"><span>{d.cadence === "one_time" ? "Date" : "Anchor / first date"}</span>
          <input type="date" value={d.anchorDate} onChange={(e) => set({ anchorDate: e.target.value })} disabled={pending} /></label>
      </div>

      {d.cadence === "monthly" && (
        <div className="fin-form-row">
          <label className="fin-field"><span>Day of month (31 = last day)</span>
            <input type="number" min="1" max="31" value={d.dayOfMonth} onChange={(e) => set({ dayOfMonth: e.target.value })} placeholder="e.g. 15" disabled={pending} /></label>
        </div>
      )}
      {d.cadence === "semimonthly" && (
        <div className="fin-form-row">
          <label className="fin-field"><span>Day A (31 = last)</span>
            <input type="number" min="1" max="31" value={d.dayA} onChange={(e) => set({ dayA: e.target.value })} disabled={pending} /></label>
          <label className="fin-field"><span>Day B (31 = last)</span>
            <input type="number" min="1" max="31" value={d.dayB} onChange={(e) => set({ dayB: e.target.value })} disabled={pending} /></label>
        </div>
      )}

      <div className="fin-form-row">
        <label className="fin-field"><span>Estimate mode</span>
          <select value={d.estimateType} onChange={(e) => set({ estimateType: e.target.value })} disabled={pending}>
            {ESTIMATES.map((x) => <option key={x.v} value={x.v}>{x.label}</option>)}
          </select></label>
        {(d.estimateType === "fixed" || d.estimateType === "typical") && (
          <label className="fin-field"><span>Expected amount</span>
            <input type="number" step="0.01" value={d.expectedAmount} onChange={(e) => set({ expectedAmount: e.target.value })} placeholder="0.00" disabled={pending} /></label>
        )}
        {d.estimateType === "range" && (
          <>
            <label className="fin-field"><span>Minimum</span>
              <input type="number" step="0.01" value={d.expectedMin} onChange={(e) => set({ expectedMin: e.target.value })} disabled={pending} /></label>
            <label className="fin-field"><span>Maximum</span>
              <input type="number" step="0.01" value={d.expectedMax} onChange={(e) => set({ expectedMax: e.target.value })} disabled={pending} /></label>
          </>
        )}
      </div>

      <div className="fin-form-row">
        <label className="fin-field"><span>Destination account</span>
          <select value={d.destinationAccountId} onChange={(e) => set({ destinationAccountId: e.target.value })} disabled={pending}>
            <option value="">Unassigned</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.linked ? " (linked)" : ""}</option>)}
          </select></label>
        <label className="fin-field"><span>End date (optional)</span>
          <input type="date" value={d.endDate} onChange={(e) => set({ endDate: e.target.value })} disabled={pending} /></label>
      </div>
      <div className="fin-form-checks">
        <label className="fin-check"><input type="checkbox" checked={d.isPayday} onChange={(e) => set({ isPayday: e.target.checked })} disabled={pending} /><span>This is a payday (drives “next expected payday”)</span></label>
      </div>
      {d.estimateType === "unknown" && (
        <div className="fin-form-note">An unknown amount forecasts the payday only — it adds $0 to projected cash until received.</div>
      )}
      <div className="fin-form-actions">
        <button className="btn" type="submit" disabled={pending || !d.source.trim() || !d.anchorDate}>{submitLabel}</button>
        <button className="linkbtn" type="button" onClick={onCancel} disabled={pending}>Cancel</button>
      </div>
    </form>
  );
}

function toDraft(s: IncomeScheduleView): Draft {
  return {
    source: s.source, cadence: s.cadence, anchorDate: s.anchorDate, estimateType: s.estimateType,
    expectedAmount: s.expectedAmount ? String(s.expectedAmount) : "",
    expectedMin: s.expectedMin != null ? String(s.expectedMin) : "",
    expectedMax: s.expectedMax != null ? String(s.expectedMax) : "",
    destinationAccountId: s.destinationAccountId != null ? String(s.destinationAccountId) : "",
    dayOfMonth: s.dayOfMonth != null ? String(s.dayOfMonth) : "",
    dayA: s.dayA != null ? String(s.dayA) : "1", dayB: s.dayB != null ? String(s.dayB) : "15",
    endDate: s.endDate ?? "", isPayday: s.isPayday,
  };
}
function serialize(d: Draft) {
  return {
    source: d.source, cadence: d.cadence, anchorDate: d.anchorDate, estimateType: d.estimateType,
    expectedAmount: d.expectedAmount === "" ? 0 : Number(d.expectedAmount),
    expectedMin: d.estimateType === "range" && d.expectedMin !== "" ? Number(d.expectedMin) : null,
    expectedMax: d.estimateType === "range" && d.expectedMax !== "" ? Number(d.expectedMax) : null,
    destinationAccountId: d.destinationAccountId === "" ? null : Number(d.destinationAccountId),
    dayOfMonth: d.cadence === "monthly" && d.dayOfMonth !== "" ? Number(d.dayOfMonth) : null,
    dayA: d.cadence === "semimonthly" ? Number(d.dayA) : null,
    dayB: d.cadence === "semimonthly" ? Number(d.dayB) : null,
    endDate: d.endDate || null, isPayday: d.isPayday,
  };
}
