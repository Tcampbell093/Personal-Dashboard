"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ExperienceRequestView } from "@/lib/types";

/** Shows what the request currently means (deterministic summary), its
 * provenance (AI vs. manually adjusted), and the owner-triggered interpret /
 * re-interpret action. The manual editor below remains the source of truth —
 * re-interpreting requires deliberately pressing this button. */
export function InterpretationSummary({
  request,
  summary,
  aiAvailable,
}: {
  request: ExperienceRequestView;
  summary: string;
  aiAvailable: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  const interpreted = request.status === "interpreted";

  async function interpret() {
    setError(null);
    setBusy(true);
    const res = await fetch(`/api/experience-requests/${request.id}/interpret`, {
      method: "POST",
    });
    setBusy(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(d?.error ?? "Interpretation failed — you can still edit details manually.");
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <div className="exp-interp">
      {interpreted && (
        <div className="exp-interp-summary">
          <span className={`badge ${request.interpretationSource === "ai" ? "explore" : ""}`}>
            {request.interpretationSource === "ai" ? "Interpreted by AI" : "Manually adjusted"}
          </span>
          <span className="sub">{summary}</span>
        </div>
      )}
      <div className="exp-actions">
        <button
          className="btn-secondary"
          type="button"
          onClick={interpret}
          disabled={busy || !aiAvailable}
          title={aiAvailable ? "" : "AI assistance is off"}
        >
          {busy ? "Working…" : interpreted ? "Re-interpret with AI" : "Help me plan this"}
        </button>
        {!aiAvailable && <span className="sub">AI is off — edit details manually below.</span>}
      </div>
      {error && <div className="taskadd-error">{error}</div>}
    </div>
  );
}
