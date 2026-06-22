"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

async function readError(res: Response): Promise<string> {
  const d = (await res.json().catch(() => null)) as { error?: string } | null;
  return d?.error ?? `Request failed (${res.status}).`;
}

/** Start a new draft request. Starting location is prefilled (read-only copy)
 * from the owner's home area; it becomes editable, request-specific data and is
 * never written back to preferences. */
export function RequestForm({ homeArea }: { homeArea: string | null }) {
  const router = useRouter();
  const [requestText, setRequestText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const t = requestText.trim();
    if (!t) return;
    setError(null);
    const res = await fetch("/api/experience-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestText: t, startingLocation: homeArea ?? undefined }),
    });
    if (!res.ok) {
      setError(await readError(res));
      return;
    }
    setRequestText("");
    startTransition(() => router.refresh());
  }

  return (
    <form onSubmit={submit}>
      <textarea
        className="exp-textarea"
        placeholder="Describe an experience you'd like — in your own words…"
        value={requestText}
        onChange={(e) => setRequestText(e.target.value)}
        disabled={pending}
        rows={3}
        aria-label="Experience request"
      />
      <div className="exp-formrow">
        {homeArea && <span className="sub">Starting location will prefill to “{homeArea}” (editable).</span>}
        <button className="btn" type="submit" disabled={pending || !requestText.trim()}>
          {pending ? "…" : "Start request"}
        </button>
      </div>
      {error && <div className="taskadd-error">{error}</div>}
    </form>
  );
}
