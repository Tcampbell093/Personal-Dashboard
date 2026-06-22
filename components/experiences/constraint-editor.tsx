"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ExperienceRequestView } from "@/lib/types";

async function readError(res: Response): Promise<string> {
  const d = (await res.json().catch(() => null)) as { error?: string } | null;
  return d?.error ?? `Request failed (${res.status}).`;
}
const str = (v: number | null) => (v == null ? "" : String(v));

/** Edit a draft request's structured constraints. Saving PATCHes the request
 * only — editing the location here never changes user_preferences.homeArea. */
export function ConstraintEditor({ request }: { request: ExperienceRequestView }) {
  const router = useRouter();
  const [f, setF] = useState({
    startingLocation: request.startingLocation ?? "",
    availableDate: request.availableDate ?? "",
    availableTimeText: request.availableTimeText ?? "",
    budgetMax: str(request.budgetMax),
    maxTravelMiles: str(request.maxTravelMiles),
    maxTravelMinutes: str(request.maxTravelMinutes),
    energyLevel: request.energyLevel ?? "",
    maxPhysicalDifficulty: request.maxPhysicalDifficulty ?? "",
    desiredFeeling: request.desiredFeeling ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  const on = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF((s) => ({ ...s, [k]: e.target.value }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    const res = await fetch(`/api/experience-requests/${request.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startingLocation: f.startingLocation,
        availableDate: f.availableDate,
        availableTimeText: f.availableTimeText,
        budgetMax: f.budgetMax,
        maxTravelMiles: f.maxTravelMiles,
        maxTravelMinutes: f.maxTravelMinutes,
        energyLevel: f.energyLevel,
        maxPhysicalDifficulty: f.maxPhysicalDifficulty,
        desiredFeeling: f.desiredFeeling,
      }),
    });
    if (!res.ok) {
      setError(await readError(res));
      return;
    }
    setSaved(true);
    startTransition(() => router.refresh());
  }

  return (
    <form className="exp-grid" onSubmit={save}>
      <label className="exp-field">
        <span>Starting location</span>
        <input className="taskadd-field" value={f.startingLocation} onChange={on("startingLocation")} disabled={pending} />
      </label>
      <label className="exp-field">
        <span>Available date</span>
        <input className="taskadd-field" type="date" value={f.availableDate} onChange={on("availableDate")} disabled={pending} />
      </label>
      <label className="exp-field">
        <span>Time / daypart</span>
        <input className="taskadd-field" value={f.availableTimeText} onChange={on("availableTimeText")} disabled={pending} placeholder="e.g. Saturday afternoon" />
      </label>
      <label className="exp-field">
        <span>Budget ($)</span>
        <input className="taskadd-field" type="number" step="0.01" min="0" value={f.budgetMax} onChange={on("budgetMax")} disabled={pending} />
      </label>
      <label className="exp-field">
        <span>Max travel (miles)</span>
        <input className="taskadd-field" type="number" min="0" value={f.maxTravelMiles} onChange={on("maxTravelMiles")} disabled={pending} />
      </label>
      <label className="exp-field">
        <span>Max travel (minutes)</span>
        <input className="taskadd-field" type="number" min="0" value={f.maxTravelMinutes} onChange={on("maxTravelMinutes")} disabled={pending} />
      </label>
      <label className="exp-field">
        <span>Energy level</span>
        <select className="taskadd-field" value={f.energyLevel} onChange={on("energyLevel")} disabled={pending}>
          <option value="">—</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </select>
      </label>
      <label className="exp-field">
        <span>Max difficulty</span>
        <select className="taskadd-field" value={f.maxPhysicalDifficulty} onChange={on("maxPhysicalDifficulty")} disabled={pending}>
          <option value="">—</option>
          <option value="easy">easy</option>
          <option value="moderate">moderate</option>
          <option value="challenging">challenging</option>
        </select>
      </label>
      <label className="exp-field">
        <span>Desired feeling</span>
        <input className="taskadd-field" value={f.desiredFeeling} onChange={on("desiredFeeling")} disabled={pending} placeholder="e.g. energized" />
      </label>
      <div className="exp-field exp-actions">
        <button className="btn" type="submit" disabled={pending}>
          {pending ? "…" : "Save constraints"}
        </button>
        {saved && <span className="sub">Saved.</span>}
      </div>
      {error && <div className="taskadd-error">{error}</div>}
    </form>
  );
}
