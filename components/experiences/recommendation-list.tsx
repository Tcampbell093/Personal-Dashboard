"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ExperienceRequestView } from "@/lib/types";
import { RecommendationCard } from "./recommendation-card";

/* Owner-triggered recommendation generation + the resulting cards. Build 2B.1
 * has NO selection control — "Choose this" arrives only in Build 2B.2. The
 * manual planning path remains available below regardless of AI state. */
export function RecommendationList({
  request,
  aiAvailable,
}: {
  request: ExperienceRequestView;
  aiAvailable: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const recs = request.recommendations;
  const hasBatch = recs.length > 0;

  async function find() {
    setError(null);
    setBusy(true);
    const res = await fetch(`/api/experience-requests/${request.id}/recommend`, {
      method: "POST",
    });
    setBusy(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(
        d?.error ??
          "Couldn't find experiences right now — you can still edit details and create a plan manually.",
      );
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <div className="exp-recs">
      <div className="exp-rec-actions">
        <button
          className="btn"
          type="button"
          onClick={find}
          disabled={busy || !aiAvailable}
          title={aiAvailable ? "" : "AI assistance is off"}
        >
          {busy ? "Finding…" : hasBatch ? "Find new options" : "Find experiences"}
        </button>
        {!aiAvailable && (
          <span className="sub">AI is off — edit details and create a plan manually below.</span>
        )}
        {hasBatch && !busy && (
          <span className="sub">AI suggestions — concepts, not verified facts.</span>
        )}
      </div>

      {busy && <div className="sub exp-rec-loading">Finding experiences…</div>}

      {hasBatch && (
        <div className="exp-rec-grid">
          {recs.map((rec) => (
            <RecommendationCard key={rec.id} rec={rec} requestId={request.id} />
          ))}
        </div>
      )}

      {error && <div className="taskadd-error">{error}</div>}
    </div>
  );
}
