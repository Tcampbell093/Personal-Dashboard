"use client";

/* Interactive obligation controls (client island) — mirrors components/tasks.tsx.
 * Mutates obligations through /api/obligations, then router.refresh() re-runs
 * the server component so the board re-sorts. */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ObligationView, Priority } from "@/lib/types";

const TYPES = [
  "appointment",
  "meeting",
  "work_shift",
  "renewal",
  "application_deadline",
  "payment",
  "personal_commitment",
  "event",
  "other_deadline",
] as const;

const IMPORTANCE: Priority[] = ["low", "medium", "high", "critical"];

async function readError(res: Response): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  return data?.error ?? `Request failed (${res.status}).`;
}

const labelize = (s: string) =>
  s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** Quick-add form. Title and start date are required. */
export function AddObligationForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [startDate, setStartDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [type, setType] = useState<(typeof TYPES)[number]>("appointment");
  const [importance, setImportance] = useState<Priority>("medium");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t || !startDate) return;
    setError(null);

    const res = await fetch("/api/obligations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: t,
        startDate,
        startTime: startTime || undefined,
        type,
        importance,
      }),
    });

    if (!res.ok) {
      setError(await readError(res));
      return;
    }
    setTitle("");
    setStartDate("");
    setStartTime("");
    setType("appointment");
    setImportance("medium");
    startTransition(() => router.refresh());
  }

  return (
    <form className="taskadd" onSubmit={submit}>
      <input
        className="taskadd-title"
        placeholder="Add an obligation…"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={pending}
        aria-label="Obligation title"
      />
      <input
        className="taskadd-field"
        type="date"
        value={startDate}
        onChange={(e) => setStartDate(e.target.value)}
        disabled={pending}
        aria-label="Start date"
        required
      />
      <input
        className="taskadd-field"
        type="time"
        value={startTime}
        onChange={(e) => setStartTime(e.target.value)}
        disabled={pending}
        aria-label="Start time"
      />
      <select
        className="taskadd-field"
        value={type}
        onChange={(e) => setType(e.target.value as (typeof TYPES)[number])}
        disabled={pending}
        aria-label="Type"
      >
        {TYPES.map((t) => (
          <option key={t} value={t}>
            {labelize(t)}
          </option>
        ))}
      </select>
      <select
        className="taskadd-field"
        value={importance}
        onChange={(e) => setImportance(e.target.value as Priority)}
        disabled={pending}
        aria-label="Importance"
      >
        {IMPORTANCE.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <button className="btn" type="submit" disabled={pending || !title.trim() || !startDate}>
        {pending ? "…" : "Add"}
      </button>
      {error && <span className="taskadd-error">{error}</span>}
    </form>
  );
}

/** Mark-done + delete buttons for one obligation row. */
export function ObligationActions({ obligation }: { obligation: ObligationView }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const done = obligation.status === "done";

  async function markDone() {
    setError(null);
    const res = await fetch(`/api/obligations/${obligation.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    if (!res.ok) {
      setError(await readError(res));
      return;
    }
    startTransition(() => router.refresh());
  }

  async function remove() {
    setError(null);
    const res = await fetch(`/api/obligations/${obligation.id}`, { method: "DELETE" });
    if (!res.ok) {
      setError(await readError(res));
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <div className="taskactions">
      {!done && (
        <button
          className="iconbtn"
          onClick={markDone}
          disabled={pending}
          title="Mark done"
          aria-label="Mark done"
        >
          ✓
        </button>
      )}
      <button
        className="iconbtn danger"
        onClick={remove}
        disabled={pending}
        title="Delete obligation"
        aria-label="Delete obligation"
      >
        ✕
      </button>
      {error && <span className="taskadd-error">{error}</span>}
    </div>
  );
}
