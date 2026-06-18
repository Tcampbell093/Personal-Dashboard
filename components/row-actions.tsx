"use client";

/* Shared dismiss + delete buttons for the read-mostly verticals (signals,
 * opportunities, jobs, interest). PATCH {status:"dismissed"} drops an item off
 * the board; DELETE soft-deletes it. */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function RowActions({
  base,
  id,
  canDismiss = true,
}: {
  base: string;
  id: number;
  canDismiss?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function call(init: RequestInit) {
    setError(null);
    const res = await fetch(`${base}/${id}`, init);
    if (!res.ok) {
      const d = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(d?.error ?? `Request failed (${res.status}).`);
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <div className="taskactions">
      {canDismiss && (
        <button
          className="iconbtn"
          disabled={pending}
          title="Dismiss"
          aria-label="Dismiss"
          onClick={() =>
            call({
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: "dismissed" }),
            })
          }
        >
          ⊘
        </button>
      )}
      <button
        className="iconbtn danger"
        disabled={pending}
        title="Delete"
        aria-label="Delete"
        onClick={() => call({ method: "DELETE" })}
      >
        ✕
      </button>
      {error && <span className="taskadd-error">{error}</span>}
    </div>
  );
}
