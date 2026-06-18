"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function AddInterestForm() {
  const router = useRouter();
  const [topic, setTopic] = useState("");
  const [title, setTitle] = useState("");
  const [source, setSource] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setError(null);
    const res = await fetch("/api/interest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic: topic || undefined,
        title: title.trim(),
        source: source || undefined,
      }),
    });
    if (!res.ok) {
      const d = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(d?.error ?? "Failed.");
      return;
    }
    setTopic("");
    setTitle("");
    setSource("");
    startTransition(() => router.refresh());
  }

  return (
    <form className="taskadd" onSubmit={submit}>
      <input
        className="taskadd-field"
        placeholder="Topic"
        value={topic}
        onChange={(e) => setTopic(e.target.value)}
        disabled={pending}
        aria-label="Topic"
      />
      <input
        className="taskadd-title"
        placeholder="Add an interest item…"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={pending}
      />
      <input
        className="taskadd-field"
        placeholder="Source"
        value={source}
        onChange={(e) => setSource(e.target.value)}
        disabled={pending}
      />
      <button className="btn" type="submit" disabled={pending || !title.trim()}>
        Add
      </button>
      {error && <span className="taskadd-error">{error}</span>}
    </form>
  );
}
