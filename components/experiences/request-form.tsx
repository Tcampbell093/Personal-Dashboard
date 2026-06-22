"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

async function readError(res: Response): Promise<string> {
  const d = (await res.json().catch(() => null)) as { error?: string } | null;
  return d?.error ?? `Request failed (${res.status}).`;
}

/** Start a new request. The natural-language description is the primary action.
 * "Help me plan this" creates the request and triggers owner-triggered AI
 * interpretation; "Start manually" creates it without AI (the fallback). The
 * prefilled starting location is request-specific and never written back to
 * preferences. */
export function RequestForm({
  homeArea,
  aiAvailable,
}: {
  homeArea: string | null;
  aiAvailable: boolean;
}) {
  const router = useRouter();
  const [requestText, setRequestText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  async function createDraft(): Promise<number | null> {
    const res = await fetch("/api/experience-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestText: requestText.trim(),
        startingLocation: homeArea ?? undefined,
      }),
    });
    if (!res.ok) {
      setError(await readError(res));
      return null;
    }
    const d = (await res.json()) as { request: { id: number } };
    return d.request.id;
  }

  async function helpMePlan(e: React.FormEvent) {
    e.preventDefault();
    if (!requestText.trim()) return;
    setError(null);
    setNote(null);
    setBusy(true);
    const id = await createDraft();
    if (id == null) {
      setBusy(false);
      return;
    }
    const res = await fetch(`/api/experience-requests/${id}/interpret`, { method: "POST" });
    setBusy(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => null)) as { error?: string } | null;
      setNote(
        d?.error ??
          "AI interpretation is unavailable — your request was saved; add details manually below.",
      );
    }
    setRequestText("");
    startTransition(() => router.refresh());
  }

  async function startManually(e: React.FormEvent) {
    e.preventDefault();
    if (!requestText.trim()) return;
    setError(null);
    setNote(null);
    setBusy(true);
    const id = await createDraft();
    setBusy(false);
    if (id == null) return;
    setRequestText("");
    startTransition(() => router.refresh());
  }

  const disabled = busy || !requestText.trim();

  return (
    <form onSubmit={helpMePlan}>
      <textarea
        className="exp-textarea exp-textarea-primary"
        placeholder="Describe an experience you'd like — in your own words. e.g. “Something memorable Saturday afternoon, about $80, no long drive, energizing but not exhausting.”"
        value={requestText}
        onChange={(e) => setRequestText(e.target.value)}
        disabled={busy}
        rows={3}
        aria-label="Experience request"
      />
      {homeArea && (
        <div className="sub" style={{ marginTop: 4 }}>
          Starting location prefills to “{homeArea}” (editable).
        </div>
      )}
      <div className="exp-formrow" style={{ marginTop: 10 }}>
        <div className="exp-actions">
          <button
            className="btn"
            type="submit"
            disabled={disabled || !aiAvailable}
            title={aiAvailable ? "" : "AI assistance is off"}
          >
            {busy ? "Working…" : "Help me plan this"}
          </button>
          <button
            className="btn-secondary"
            type="button"
            onClick={startManually}
            disabled={disabled}
          >
            Start manually
          </button>
        </div>
      </div>
      {!aiAvailable && (
        <div className="sub" style={{ marginTop: 6 }}>
          AI assistance is off — use “Start manually” and fill in details below.
        </div>
      )}
      {note && <div className="sub" style={{ marginTop: 6 }}>{note}</div>}
      {error && <div className="taskadd-error">{error}</div>}
    </form>
  );
}
