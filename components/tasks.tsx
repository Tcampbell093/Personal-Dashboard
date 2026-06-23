"use client";

/* Interactive task controls (client island).
 *
 * The dashboard is a server component that reads tasks from the DB. These small
 * client pieces mutate tasks through the /api/tasks endpoints and then call
 * router.refresh(), which re-runs the server component so the triage re-sorts
 * with the new state. No client-side data store — the server stays the source
 * of truth. */

import { useState, useTransition, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import type { Priority, TaskView } from "@/lib/types";

const UNDO_WINDOW_MS = 6000;

const PRIORITIES: Priority[] = ["low", "medium", "high", "critical"];

async function readError(res: Response): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  return data?.error ?? `Request failed (${res.status}).`;
}

/** Quick-add form. Title is required; priority and due date are optional. */
export function AddTaskForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [dueDate, setDueDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    setError(null);

    const res = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: t,
        priority,
        dueDate: dueDate || undefined,
      }),
    });

    if (!res.ok) {
      setError(await readError(res));
      return;
    }
    setTitle("");
    setDueDate("");
    setPriority("medium");
    startTransition(() => router.refresh());
  }

  return (
    <form className="taskadd" onSubmit={submit}>
      <input
        className="taskadd-title"
        placeholder="Add a task…"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={pending}
        aria-label="Task title"
      />
      <select
        className="taskadd-field"
        value={priority}
        onChange={(e) => setPriority(e.target.value as Priority)}
        disabled={pending}
        aria-label="Priority"
      >
        {PRIORITIES.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <input
        className="taskadd-field"
        type="date"
        value={dueDate}
        onChange={(e) => setDueDate(e.target.value)}
        disabled={pending}
        aria-label="Due date"
      />
      <button className="btn" type="submit" disabled={pending || !title.trim()}>
        {pending ? "…" : "Add"}
      </button>
      {error && <span className="taskadd-error">{error}</span>}
    </form>
  );
}

async function patchStatus(taskId: number, status: string): Promise<Response> {
  return fetch(`/api/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

/** Complete + delete for one active task row. On completion the task is persisted
 * as completed immediately (never deleted), and a confirmation with a short-lived
 * Undo is shown; after the undo window (or on Undo) the view refreshes so the task
 * moves to Recently completed (or back to active on Undo). */
export function TaskActions({ task }: { task: TaskView }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [justCompleted, setJustCompleted] = useState(false);
  const [pending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const done = task.status === "completed";

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function complete() {
    setError(null);
    const res = await patchStatus(task.id, "completed");
    if (!res.ok) { setError(await readError(res)); return; }
    setJustCompleted(true); // confirmation + undo window; refresh deferred
    timer.current = setTimeout(() => startTransition(() => router.refresh()), UNDO_WINDOW_MS);
  }

  async function undo() {
    if (timer.current) clearTimeout(timer.current);
    setError(null);
    const res = await patchStatus(task.id, "not_started"); // reopen clears completedAt
    if (!res.ok) { setError(await readError(res)); return; }
    setJustCompleted(false);
    startTransition(() => router.refresh());
  }

  async function remove() {
    setError(null);
    const res = await fetch(`/api/tasks/${task.id}`, { method: "DELETE" });
    if (!res.ok) { setError(await readError(res)); return; }
    startTransition(() => router.refresh());
  }

  if (justCompleted) {
    return (
      <div className="taskactions task-completed-toast" role="status">
        <span className="task-completed-msg">Completed ✓</span>
        <button className="btn-secondary" type="button" onClick={undo} disabled={pending}>
          Undo
        </button>
      </div>
    );
  }

  return (
    <div className="taskactions">
      {!done && (
        <button
          className="iconbtn"
          onClick={complete}
          disabled={pending}
          title="Mark complete"
          aria-label="Mark complete"
        >
          ✓
        </button>
      )}
      <button
        className="iconbtn danger"
        onClick={remove}
        disabled={pending}
        title="Delete task"
        aria-label="Delete task"
      >
        ✕
      </button>
      {error && <span className="taskadd-error">{error}</span>}
    </div>
  );
}

/** Reopen a completed task from the Recently completed list. */
export function ReopenTask({ taskId }: { taskId: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function reopen() {
    setBusy(true);
    setError(null);
    const res = await patchStatus(taskId, "not_started");
    setBusy(false);
    if (!res.ok) { setError(await readError(res)); return; }
    startTransition(() => router.refresh());
  }

  return (
    <>
      <button className="btn-secondary" type="button" onClick={reopen} disabled={busy} title="Reopen task">
        {busy ? "…" : "Reopen"}
      </button>
      {error && <span className="taskadd-error">{error}</span>}
    </>
  );
}
