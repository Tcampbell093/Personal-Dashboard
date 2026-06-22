"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ExperienceView } from "@/lib/types";
import { OutcomeForm } from "./outcome-form";

async function readError(res: Response): Promise<string> {
  const d = (await res.json().catch(() => null)) as { error?: string } | null;
  return d?.error ?? `Request failed (${res.status}).`;
}
function money(n: number | null): string {
  return n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
function shortDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function PlannedItem({ e }: { e: ExperienceView }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState({
    title: e.title,
    plannedDate: e.plannedDate ?? "",
    locationText: e.locationText ?? "",
    expectedCost: e.expectedCost != null ? String(e.expectedCost) : "",
    notes: e.notes ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const on = (k: keyof typeof f) => (ev: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF((s) => ({ ...s, [k]: ev.target.value }));

  async function saveEdit(ev: React.FormEvent) {
    ev.preventDefault();
    if (!f.title.trim()) return;
    setError(null);
    const res = await fetch(`/api/experiences/${e.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: f.title.trim(),
        plannedDate: f.plannedDate,
        locationText: f.locationText,
        expectedCost: f.expectedCost,
        notes: f.notes,
      }),
    });
    if (!res.ok) {
      setError(await readError(res));
      return;
    }
    setEditing(false);
    startTransition(() => router.refresh());
  }

  async function remove() {
    setError(null);
    const res = await fetch(`/api/experiences/${e.id}`, { method: "DELETE" });
    if (!res.ok) {
      setError(await readError(res));
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <div className="card edge-act" style={{ marginBottom: "var(--gap)" }}>
      <div className="row" style={{ borderTop: "none" }}>
        <div>
          <div className="main">{e.title}</div>
          <div className="sub">
            {shortDate(e.plannedDate)}
            {e.plannedTimeText ? ` · ${e.plannedTimeText}` : ""}
            {e.locationText ? ` · ${e.locationText}` : ""}
            {e.expectedCost != null ? ` · est ${money(e.expectedCost)}` : ""}
          </div>
          {e.description && <div className="sub">{e.description}</div>}
        </div>
        <div className="right">
          <span className="badge act">planned</span>
          <div className="taskactions">
            <button className="btn-secondary" type="button" onClick={() => setEditing((v) => !v)} disabled={pending}>Edit</button>
            <button className="btn-secondary danger" type="button" onClick={remove} disabled={pending}>Delete</button>
          </div>
        </div>
      </div>

      {editing && (
        <form className="exp-grid" onSubmit={saveEdit}>
          <label className="exp-field exp-span"><span>Title *</span>
            <input className="taskadd-field" value={f.title} onChange={on("title")} disabled={pending} /></label>
          <label className="exp-field"><span>Planned date</span>
            <input className="taskadd-field" type="date" value={f.plannedDate} onChange={on("plannedDate")} disabled={pending} /></label>
          <label className="exp-field"><span>Location</span>
            <input className="taskadd-field" value={f.locationText} onChange={on("locationText")} disabled={pending} /></label>
          <label className="exp-field"><span>Expected cost ($)</span>
            <input className="taskadd-field" type="number" step="0.01" min="0" value={f.expectedCost} onChange={on("expectedCost")} disabled={pending} /></label>
          <label className="exp-field exp-span"><span>Notes</span>
            <textarea className="taskadd-field" rows={2} value={f.notes} onChange={on("notes")} disabled={pending} /></label>
          <div className="exp-field exp-actions exp-span">
            <button className="btn" type="submit" disabled={pending || !f.title.trim()}>{pending ? "…" : "Save plan"}</button>
            <button className="btn-secondary" type="button" onClick={() => setEditing(false)} disabled={pending}>Cancel</button>
          </div>
        </form>
      )}

      <OutcomeForm experience={e} mode="resolve" />
      {error && <div className="taskadd-error">{error}</div>}
    </div>
  );
}

export function PlannedList({ experiences }: { experiences: ExperienceView[] }) {
  if (experiences.length === 0) {
    return <div className="empty">No planned experiences yet. Create one from a draft above.</div>;
  }
  return (
    <>
      {experiences.map((e) => (
        <PlannedItem e={e} key={e.id} />
      ))}
    </>
  );
}
