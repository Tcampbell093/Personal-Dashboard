"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { SIGNAL_TYPES } from "@/lib/services/signals";

const labelize = (s: string) =>
  s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export function AddSignalForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [type, setType] = useState<string>("local_event");
  const [location, setLocation] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setError(null);
    const res = await fetch("/api/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: title.trim(),
        type,
        location: location || undefined,
        eventDate: eventDate || undefined,
      }),
    });
    if (!res.ok) {
      const d = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(d?.error ?? "Failed.");
      return;
    }
    setTitle("");
    setLocation("");
    setEventDate("");
    startTransition(() => router.refresh());
  }

  return (
    <form className="taskadd" onSubmit={submit}>
      <input
        className="taskadd-title"
        placeholder="Add a signal…"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={pending}
      />
      <select
        className="taskadd-field"
        value={type}
        onChange={(e) => setType(e.target.value)}
        disabled={pending}
        aria-label="Signal type"
      >
        {SIGNAL_TYPES.map((t) => (
          <option key={t} value={t}>
            {labelize(t)}
          </option>
        ))}
      </select>
      <input
        className="taskadd-field"
        placeholder="Location"
        value={location}
        onChange={(e) => setLocation(e.target.value)}
        disabled={pending}
      />
      <input
        className="taskadd-field"
        type="date"
        value={eventDate}
        onChange={(e) => setEventDate(e.target.value)}
        disabled={pending}
        aria-label="Event date"
      />
      <button className="btn" type="submit" disabled={pending || !title.trim()}>
        Add
      </button>
      {error && <span className="taskadd-error">{error}</span>}
    </form>
  );
}
