"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { OPPORTUNITY_CATEGORIES } from "@/lib/services/opportunities";

const labelize = (s: string) =>
  s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export function AddOpportunityForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<string>("other");
  const [potentialValue, setPotentialValue] = useState("");
  const [timeWindowEnd, setTimeWindowEnd] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setError(null);
    const res = await fetch("/api/opportunities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: title.trim(),
        category,
        potentialValue: potentialValue || undefined,
        timeWindowEnd: timeWindowEnd || undefined,
      }),
    });
    if (!res.ok) {
      const d = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(d?.error ?? "Failed.");
      return;
    }
    setTitle("");
    setPotentialValue("");
    setTimeWindowEnd("");
    startTransition(() => router.refresh());
  }

  return (
    <form className="taskadd" onSubmit={submit}>
      <input
        className="taskadd-title"
        placeholder="Add an opportunity…"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={pending}
      />
      <select
        className="taskadd-field"
        value={category}
        onChange={(e) => setCategory(e.target.value)}
        disabled={pending}
        aria-label="Category"
      >
        {OPPORTUNITY_CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {labelize(c)}
          </option>
        ))}
      </select>
      <input
        className="taskadd-field"
        type="number"
        step="0.01"
        placeholder="Value $"
        value={potentialValue}
        onChange={(e) => setPotentialValue(e.target.value)}
        disabled={pending}
        aria-label="Potential value"
      />
      <input
        className="taskadd-field"
        type="date"
        value={timeWindowEnd}
        onChange={(e) => setTimeWindowEnd(e.target.value)}
        disabled={pending}
        aria-label="Closes"
      />
      <button className="btn" type="submit" disabled={pending || !title.trim()}>
        Add
      </button>
      {error && <span className="taskadd-error">{error}</span>}
    </form>
  );
}
