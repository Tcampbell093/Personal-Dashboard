"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/* The one money action on Home: mark a due bill paid. Reuses the EXISTING bills
 * PATCH API (same call the full FinanceManager makes) — no new mutation logic. */
export function MarkBillPaid({ billId }: { billId: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [, startTransition] = useTransition();

  async function pay() {
    setBusy(true);
    setError(false);
    const res = await fetch(`/api/finances/bills/${billId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "paid" }),
    });
    setBusy(false);
    if (res.ok) {
      startTransition(() => router.refresh());
    } else {
      setError(true);
    }
  }

  return (
    <button
      className="btn-secondary"
      type="button"
      onClick={pay}
      disabled={busy}
      title="Mark paid"
    >
      {busy ? "…" : error ? "Retry" : "Mark paid"}
    </button>
  );
}
