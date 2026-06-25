/* Finance 1A.2 — pure split-allocation math (no DB; safe for client + server).
 *
 * Resolution order: fixed → percent-of-remaining → remainder (which absorbs the
 * deterministic rounding difference). All arithmetic is in integer cents, so
 * there is no floating-point drift and allocations always sum exactly to gross. */

export interface AllocationInput {
  accountId: number;
  allocationType: "fixed" | "percent" | "remainder";
  value: number | null; // dollars (fixed) | percent (percent) | null (remainder)
}
export interface AllocationShare {
  accountId: number;
  cents: number;
  type: string;
}

const allocRank = (t: string) => (t === "fixed" ? 0 : t === "percent" ? 1 : 2);

/** Structural validation of an allocation set, independent of the gross amount. */
export function validateAllocationSet(rows: AllocationInput[]): string | null {
  if (!rows.length) return "Add at least one allocation.";
  const remainders = rows.filter((r) => r.allocationType === "remainder");
  if (remainders.length > 1) return "Only one remainder allocation is allowed.";
  const seen = new Set<number>();
  let percentBps = 0;
  let hasPercent = false;
  for (const r of rows) {
    if (!Number.isInteger(r.accountId) || r.accountId <= 0) return "Invalid destination account.";
    if (seen.has(r.accountId)) return "Each destination account may appear only once.";
    seen.add(r.accountId);
    if (r.allocationType === "fixed") {
      if (r.value == null || !(r.value > 0)) return "Fixed allocations must be a positive amount.";
    } else if (r.allocationType === "percent") {
      if (r.value == null || !(r.value > 0)) return "Percentage allocations must be greater than 0%.";
      if (r.value > 100) return "A percentage allocation cannot exceed 100%.";
      hasPercent = true;
      percentBps += Math.round(r.value * 100);
    }
  }
  if (percentBps > 10000) return "Percentage allocations cannot total more than 100%.";
  const hasRemainder = remainders.length === 1;
  if (!hasRemainder && hasPercent && percentBps !== 10000)
    return "Without a remainder allocation, percentages must total exactly 100%.";
  return null;
}

/**
 * Resolve an allocation set against a gross amount (dollars) into integer-cent
 * shares. Returns `{ error }` when the set cannot fully + exactly distribute the
 * gross. The order is preserved as fixed → percent → remainder in the output.
 */
export function computeAllocationShares(
  grossDollars: number,
  rows: AllocationInput[],
): { error?: string; shares: AllocationShare[] } {
  const structural = validateAllocationSet(rows);
  if (structural) return { error: structural, shares: [] };
  const grossCents = Math.round(grossDollars * 100);
  if (grossCents <= 0) return { error: "Gross amount must be positive.", shares: [] };

  const ordered = [...rows].sort((a, b) => allocRank(a.allocationType) - allocRank(b.allocationType));
  const fixedCents = ordered
    .filter((r) => r.allocationType === "fixed")
    .reduce((s, r) => s + Math.round((r.value as number) * 100), 0);
  if (fixedCents > grossCents)
    return {
      error: `Fixed allocations ($${(fixedCents / 100).toFixed(2)}) exceed the gross amount ($${(grossCents / 100).toFixed(2)}).`,
      shares: [],
    };
  const remainingAfterFixed = grossCents - fixedCents;

  const shares: AllocationShare[] = [];
  for (const r of ordered.filter((r) => r.allocationType === "fixed"))
    shares.push({ accountId: r.accountId, cents: Math.round((r.value as number) * 100), type: "fixed" });
  for (const r of ordered.filter((r) => r.allocationType === "percent")) {
    const bps = Math.round((r.value as number) * 100);
    shares.push({
      accountId: r.accountId,
      cents: Math.floor((remainingAfterFixed * bps) / 10000),
      type: "percent",
    });
  }
  const assigned = shares.reduce((s, x) => s + x.cents, 0);
  let leftover = grossCents - assigned; // >= 0 (fixed<=gross, percent<=100)
  const rem = ordered.find((r) => r.allocationType === "remainder");
  if (rem) {
    shares.push({ accountId: rem.accountId, cents: leftover, type: "remainder" });
    leftover = 0;
  } else if (leftover !== 0) {
    if (shares.some((x) => x.type === "percent")) {
      shares[shares.length - 1].cents += leftover; // pure rounding (percent==100)
      leftover = 0;
    } else {
      return {
        error: `Allocations ($${((grossCents - leftover) / 100).toFixed(2)}) do not total the gross amount ($${(grossCents / 100).toFixed(2)}); add a remainder allocation.`,
        shares: [],
      };
    }
  }
  const total = shares.reduce((s, x) => s + x.cents, 0);
  if (total !== grossCents) return { error: "Allocations do not sum exactly to the gross amount.", shares: [] };
  if (shares.some((x) => x.cents < 0)) return { error: "An allocation resolved to a negative amount.", shares: [] };
  return { shares };
}
