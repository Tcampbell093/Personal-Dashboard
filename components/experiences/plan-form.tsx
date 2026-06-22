"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

async function readError(res: Response): Promise<string> {
  const d = (await res.json().catch(() => null)) as { error?: string } | null;
  return d?.error ?? `Request failed (${res.status}).`;
}

/** Manually create a planned experience from this request. */
export function PlanForm({
  requestId,
  defaultLocation,
}: {
  requestId: number;
  defaultLocation: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    title: "",
    plannedDate: "",
    plannedTimeText: "",
    locationText: defaultLocation ?? "",
    expectedCost: "",
    expectedDurationMinutes: "",
    physicalDifficulty: "",
    notes: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const on = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setF((s) => ({ ...s, [k]: e.target.value }));

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!f.title.trim()) return;
    setError(null);
    const res = await fetch("/api/experiences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId,
        title: f.title.trim(),
        plannedDate: f.plannedDate,
        plannedTimeText: f.plannedTimeText,
        locationText: f.locationText,
        expectedCost: f.expectedCost,
        expectedDurationMinutes: f.expectedDurationMinutes,
        physicalDifficulty: f.physicalDifficulty,
        notes: f.notes,
      }),
    });
    if (!res.ok) {
      setError(await readError(res));
      return;
    }
    startTransition(() => router.refresh());
  }

  if (!open) {
    return (
      <div className="exp-actions">
        <button className="btn" type="button" onClick={() => setOpen(true)}>
          Create a plan
        </button>
      </div>
    );
  }

  return (
    <form className="exp-grid exp-planform" onSubmit={create}>
      <label className="exp-field exp-span">
        <span>Plan title *</span>
        <input className="taskadd-field" value={f.title} onChange={on("title")} disabled={pending} autoFocus />
      </label>
      <label className="exp-field">
        <span>Planned date</span>
        <input className="taskadd-field" type="date" value={f.plannedDate} onChange={on("plannedDate")} disabled={pending} />
      </label>
      <label className="exp-field">
        <span>Time / daypart</span>
        <input className="taskadd-field" value={f.plannedTimeText} onChange={on("plannedTimeText")} disabled={pending} />
      </label>
      <label className="exp-field">
        <span>Location</span>
        <input className="taskadd-field" value={f.locationText} onChange={on("locationText")} disabled={pending} />
      </label>
      <label className="exp-field">
        <span>Expected cost ($)</span>
        <input className="taskadd-field" type="number" step="0.01" min="0" value={f.expectedCost} onChange={on("expectedCost")} disabled={pending} />
      </label>
      <label className="exp-field">
        <span>Duration (min)</span>
        <input className="taskadd-field" type="number" min="0" value={f.expectedDurationMinutes} onChange={on("expectedDurationMinutes")} disabled={pending} />
      </label>
      <label className="exp-field">
        <span>Difficulty</span>
        <select className="taskadd-field" value={f.physicalDifficulty} onChange={on("physicalDifficulty")} disabled={pending}>
          <option value="">—</option>
          <option value="easy">easy</option>
          <option value="moderate">moderate</option>
          <option value="challenging">challenging</option>
        </select>
      </label>
      <label className="exp-field exp-span">
        <span>Notes</span>
        <textarea className="taskadd-field" rows={2} value={f.notes} onChange={on("notes")} disabled={pending} />
      </label>
      <div className="exp-field exp-actions exp-span">
        <button className="btn" type="submit" disabled={pending || !f.title.trim()}>
          {pending ? "…" : "Save planned experience"}
        </button>
        <button className="iconbtn" type="button" onClick={() => setOpen(false)} disabled={pending} title="Cancel">
          ✕
        </button>
      </div>
      {error && <div className="taskadd-error">{error}</div>}
    </form>
  );
}
