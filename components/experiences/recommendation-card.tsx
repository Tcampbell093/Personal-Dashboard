"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ExperienceRecommendation } from "@/lib/types";

function money(n: number): string {
  return `$${n.toLocaleString("en-US")}`;
}
function costRange(min: number | null, max: number | null): string {
  if (min == null && max == null) return "Cost varies";
  if (min != null && max != null) return min === max ? money(min) : `${money(min)}–${money(max)}`;
  return money((min ?? max) as number);
}
function duration(m: number | null): string | null {
  if (m == null) return null;
  if (m >= 90) return `~${Math.round((m / 60) * 10) / 10} hr`;
  return `~${m} min`;
}

/* A single recommendation concept with a "Choose this" action (Build 2B.2).
 * Selecting sends ONLY the recommendation id; the server resolves every plan
 * value from the stored batch and atomically creates the planned experience.
 * On success the request becomes `planned` and leaves the open list (cards and
 * this control disappear); the plan appears under Planned experiences. */
export function RecommendationCard({
  rec,
  requestId,
}: {
  rec: ExperienceRecommendation;
  requestId: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const dur = duration(rec.estimatedDurationMinutes);

  async function choose() {
    setError(null);
    setBusy(true);
    const res = await fetch(`/api/experience-requests/${requestId}/select-recommendation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recommendationId: rec.id }),
    });
    if (!res.ok) {
      const d = (await res.json().catch(() => null)) as { error?: string } | null;
      setBusy(false);
      setError(d?.error ?? "Couldn't create the plan. Refresh and try again.");
      // Refresh so the UI reflects server truth (e.g. another tab already planned it).
      startTransition(() => router.refresh());
      return;
    }
    // Success: refresh; the request leaves the open list and the plan appears below.
    startTransition(() => router.refresh());
  }

  return (
    <div className="exp-rec-card">
      <div className="exp-rec-title">{rec.title}</div>
      <div className="exp-rec-desc">{rec.description}</div>

      <div className="exp-rec-why">
        <span className="exp-rec-why-label">Why it fits</span>
        {rec.whyItFits}
      </div>

      <div className="exp-rec-meta num">
        <span className="exp-rec-chip">{costRange(rec.estimatedCostMin, rec.estimatedCostMax)}</span>
        {dur && <span className="exp-rec-chip">{dur}</span>}
        {rec.physicalDifficulty && <span className="exp-rec-chip">{rec.physicalDifficulty}</span>}
        {rec.locationText && <span className="exp-rec-chip">{rec.locationText}</span>}
      </div>

      {rec.travelAssumption && <div className="exp-rec-sub">Travel: {rec.travelAssumption}</div>}

      {rec.assumptions.length > 0 && (
        <ul className="exp-rec-assumptions">
          {rec.assumptions.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      )}

      {rec.preparationNotes.length > 0 && (
        <div className="exp-rec-sub">Prep: {rec.preparationNotes.join("; ")}</div>
      )}

      <div className="exp-rec-verify">
        Concept based on your request. Confirm current hours, pricing, availability, and travel
        details before going.
      </div>

      <button className="btn exp-rec-choose" type="button" onClick={choose} disabled={busy}>
        {busy ? "Choosing…" : "Choose this"}
      </button>
      {error && <div className="taskadd-error">{error}</div>}
    </div>
  );
}
