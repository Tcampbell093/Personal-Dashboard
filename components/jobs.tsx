"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { WORK_ARRANGEMENTS } from "@/lib/services/jobs";

export function AddJobForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [company, setCompany] = useState("");
  const [location, setLocation] = useState("");
  const [workArrangement, setWorkArrangement] = useState<string>("remote");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setError(null);
    const res = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: title.trim(),
        company: company || undefined,
        location: location || undefined,
        workArrangement,
      }),
    });
    if (!res.ok) {
      const d = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(d?.error ?? "Failed.");
      return;
    }
    setTitle("");
    setCompany("");
    setLocation("");
    startTransition(() => router.refresh());
  }

  return (
    <form className="taskadd" onSubmit={submit}>
      <input
        className="taskadd-title"
        placeholder="Add a job…"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={pending}
      />
      <input
        className="taskadd-field"
        placeholder="Company"
        value={company}
        onChange={(e) => setCompany(e.target.value)}
        disabled={pending}
      />
      <input
        className="taskadd-field"
        placeholder="Location"
        value={location}
        onChange={(e) => setLocation(e.target.value)}
        disabled={pending}
      />
      <select
        className="taskadd-field"
        value={workArrangement}
        onChange={(e) => setWorkArrangement(e.target.value)}
        disabled={pending}
        aria-label="Work arrangement"
      >
        {WORK_ARRANGEMENTS.map((w) => (
          <option key={w} value={w}>
            {w}
          </option>
        ))}
      </select>
      <button className="btn" type="submit" disabled={pending || !title.trim()}>
        Add
      </button>
      {error && <span className="taskadd-error">{error}</span>}
    </form>
  );
}
