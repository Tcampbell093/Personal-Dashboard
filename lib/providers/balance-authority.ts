/* =============================================================================
 * Xanther — balance-authority resolver (Finance 1B.0)
 *
 * Provider-neutral, PURE design for "what is an account's authoritative ACTUAL
 * balance, and how fresh is it?" — without changing the projection engine.
 *
 * Rules (approved Finance 1B defaults):
 *  - A MANUAL account's actual balance is `financial_accounts.currentBalance`.
 *  - A LINKED account's actual balance is its latest PROVIDER balance snapshot,
 *    and that balance is provider-authoritative (Xanther never overwrites it).
 *  - A linked balance always carries an `asOf` freshness timestamp.
 *  - A stale/disconnected linked account may expose its last-known balance ONLY
 *    when explicitly labeled stale.
 *  - A MISSING linked balance must NOT silently fall back to the old manual
 *    `currentBalance`; it resolves to "unavailable" (actual = null).
 *  - Projections consume the resolved authoritative actual balance but never
 *    write it back.
 *
 * Pure module: no I/O, no DB, no provider SDK. This does not yet wire into the
 * projection engine; it is the type-only seam a later build will consume.
 * ===========================================================================*/

export type BalanceSource = "manual" | "linked";

/** A cached provider balance snapshot for one linked account. */
export interface ProviderBalanceSnapshot {
  /** Authoritative actual balance from the provider (may be null if unknown). */
  readonly actual: number | null;
  /** ISO-8601 freshness; required so the UI can show "last updated". */
  readonly asOf: string;
  /** Connection health affecting whether the snapshot is current or stale. */
  readonly status: "active" | "stale" | "disconnected";
}

export interface BalanceAuthorityInput {
  readonly balanceSource: BalanceSource;
  /** The manual ledger balance (used only for manual accounts). */
  readonly manualBalance: number;
  /** Latest provider snapshot for a linked account (absent if never synced). */
  readonly providerSnapshot?: ProviderBalanceSnapshot | null;
}

/**
 * The resolved authoritative actual balance + provenance. `actual` is null only
 * when a linked balance is genuinely unavailable — callers must treat null as
 * "unknown", never as zero and never as the manual balance.
 */
export type ResolvedBalance =
  | { readonly kind: "manual"; readonly actual: number; readonly source: "manual"; readonly stale: false; readonly asOf: null }
  | { readonly kind: "linked_fresh"; readonly actual: number; readonly source: "provider"; readonly stale: false; readonly asOf: string }
  | { readonly kind: "linked_stale"; readonly actual: number; readonly source: "provider"; readonly stale: true; readonly asOf: string }
  | { readonly kind: "linked_unavailable"; readonly actual: null; readonly source: "provider"; readonly stale: true; readonly asOf: string | null; readonly reason: string };

/**
 * Resolve the authoritative actual balance for an account. Pure and total: every
 * input shape maps to exactly one ResolvedBalance; a linked account with no
 * usable snapshot returns `linked_unavailable` (NEVER the manual balance).
 */
export function resolveBalanceAuthority(input: BalanceAuthorityInput): ResolvedBalance {
  if (input.balanceSource === "manual") {
    return { kind: "manual", actual: input.manualBalance, source: "manual", stale: false, asOf: null };
  }

  // Linked account from here on — provider is authoritative.
  const snap = input.providerSnapshot;
  if (!snap || snap.actual == null) {
    // No usable provider balance. Do NOT fall back to the manual balance.
    return {
      kind: "linked_unavailable",
      actual: null,
      source: "provider",
      stale: true,
      asOf: snap?.asOf ?? null,
      reason: !snap ? "no provider balance snapshot yet" : "provider balance unknown",
    };
  }

  if (snap.status === "active") {
    return { kind: "linked_fresh", actual: snap.actual, source: "provider", stale: false, asOf: snap.asOf };
  }

  // stale | disconnected → last-known balance, explicitly labeled stale.
  return { kind: "linked_stale", actual: snap.actual, source: "provider", stale: true, asOf: snap.asOf };
}

/** True when the resolved balance is safe to treat as a known number. */
export function hasKnownActual(b: ResolvedBalance): boolean {
  return b.actual != null;
}
