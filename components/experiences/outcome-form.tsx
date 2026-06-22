"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ExperienceView, ExperienceStatus } from "@/lib/types";

async function readError(res: Response): Promise<string> {
  const d = (await res.json().catch(() => null)) as { error?: string } | null;
  return d?.error ?? `Request failed (${res.status}).`;
}

/** Client-side XP preview. The server remains authoritative. */
function previewXp(status: ExperienceStatus, meaningful: boolean): number {
  if (status === "completed") return meaningful ? 15 : 10;
  return 0;
}

/**
 * mode "resolve": planned -> completed/cancelled/not_completed (POST /resolve).
 * mode "correct": edit resolved details only, never status (PATCH /outcome).
 */
export function OutcomeForm({
  experience,
  mode,
}: {
  experience: ExperienceView;
  mode: "resolve" | "correct";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ExperienceStatus>(
    mode === "correct" ? experience.status : "completed",
  );
  const [actualCost, setActualCost] = useState(
    experience.actualCost != null ? String(experience.actualCost) : "",
  );
  const [rating, setRating] = useState(experience.rating != null ? String(experience.rating) : "");
  const [reflection, setReflection] = useState(experience.reflection ?? "");
  const [reason, setReason] = useState(experience.nonCompletionReason ?? "");
  const [meaningful, setMeaningful] = useState(experience.meaningfulExperience);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const effectiveStatus = mode === "correct" ? experience.status : status;
  const xp = previewXp(effectiveStatus, meaningful);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const payload: Record<string, unknown> = {
      actualCost,
      rating,
      reflection,
      nonCompletionReason: reason,
      meaningfulExperience: meaningful,
    };
    let url: string;
    let method: string;
    if (mode === "resolve") {
      url = `/api/experiences/${experience.id}/resolve`;
      method = "POST";
      payload.status = status;
    } else {
      url = `/api/experiences/${experience.id}/outcome`;
      method = "PATCH";
    }
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      setError(await readError(res));
      return;
    }
    setOpen(false);
    startTransition(() => router.refresh());
  }

  if (!open) {
    return (
      <div className="exp-actions">
        <button className="btn" type="button" onClick={() => setOpen(true)}>
          {mode === "resolve" ? "Resolve outcome" : "Correct details"}
        </button>
      </div>
    );
  }

  return (
    <form className="exp-grid exp-outcome" onSubmit={submit}>
      {mode === "resolve" ? (
        <label className="exp-field">
          <span>Outcome</span>
          <select className="taskadd-field" value={status} onChange={(e) => setStatus(e.target.value as ExperienceStatus)} disabled={pending}>
            <option value="completed">completed</option>
            <option value="cancelled">cancelled</option>
            <option value="not_completed">not completed</option>
          </select>
        </label>
      ) : (
        <div className="exp-field">
          <span>Outcome</span>
          <div className="taskadd-field" style={{ opacity: 0.7 }}>{experience.status} (final)</div>
        </div>
      )}
      <label className="exp-field">
        <span>Actual cost ($)</span>
        <input className="taskadd-field" type="number" step="0.01" min="0" value={actualCost} onChange={(e) => setActualCost(e.target.value)} disabled={pending} />
      </label>
      <label className="exp-field">
        <span>Rating</span>
        <select className="taskadd-field" value={rating} onChange={(e) => setRating(e.target.value)} disabled={pending}>
          <option value="">—</option>
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </label>
      <label className="exp-field exp-checkbox">
        <input type="checkbox" checked={meaningful} onChange={(e) => setMeaningful(e.target.checked)} disabled={pending} />
        <span>This felt like a meaningful experience</span>
      </label>
      <label className="exp-field exp-span">
        <span>Reflection</span>
        <textarea className="taskadd-field" rows={2} value={reflection} onChange={(e) => setReflection(e.target.value)} disabled={pending} />
      </label>
      <label className="exp-field exp-span">
        <span>Non-completion reason (optional)</span>
        <input className="taskadd-field" value={reason} onChange={(e) => setReason(e.target.value)} disabled={pending} />
      </label>
      <div className="exp-field exp-actions exp-span">
        <span className="badge good">XP will be {xp}</span>
        <button className="btn" type="submit" disabled={pending}>
          {pending ? "…" : mode === "resolve" ? "Save outcome" : "Save corrections"}
        </button>
        <button className="btn-secondary" type="button" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </button>
      </div>
      {error && <div className="taskadd-error">{error}</div>}
    </form>
  );
}
