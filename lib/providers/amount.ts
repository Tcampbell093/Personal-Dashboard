/* =============================================================================
 * Xanther — canonical imported-transaction sign convention (Finance 1B.0)
 *
 * ONE convention for every imported financial transaction, everywhere in the
 * finance domain:
 *
 *     inflow  (money INTO an owned account)  →  POSITIVE  (> 0)
 *     outflow (money OUT of an owned account) →  NEGATIVE (< 0)
 *     zero is INVALID for an imported transaction (no provider-specific reason
 *           to support a $0 imported movement is enabled in the initial version)
 *
 * Provider adapters normalize their provider-native amounts into this convention
 * BEFORE returning any DTO. No provider-native sign convention may leak into the
 * matching or UI services — they only ever see Xanther-signed amounts.
 *
 * Pure module: no I/O, no provider SDK, no network.
 * ===========================================================================*/

/**
 * How a provider expresses the sign of a transaction amount, so an adapter can
 * declare it once and normalize deterministically.
 *  - "outflow_positive": positive = money leaving the account (Plaid's
 *    convention — a purchase is positive, a deposit is negative).
 *  - "inflow_positive": positive = money entering the account (already matches
 *    Xanther; passed through unchanged).
 */
export type ProviderSignConvention = "outflow_positive" | "inflow_positive";

/** Thrown when a provider amount cannot be normalized to a valid Xanther sign. */
export class AmountNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmountNormalizationError";
  }
}

/**
 * Assert a number is a valid Xanther imported-transaction amount: finite and
 * non-zero. Inflow/outflow direction is encoded in the sign, not here.
 */
export function assertImportedAmount(amount: number): void {
  if (!Number.isFinite(amount)) {
    throw new AmountNormalizationError("Imported amount must be a finite number.");
  }
  if (amount === 0) {
    throw new AmountNormalizationError("Imported amount of 0 is invalid.");
  }
}

/**
 * Normalize a provider's raw signed amount into the Xanther convention
 * (inflow > 0, outflow < 0). The adapter declares the provider's convention;
 * everything downstream sees only the normalized value.
 */
export function toXantherAmount(rawAmount: number, convention: ProviderSignConvention): number {
  if (!Number.isFinite(rawAmount)) {
    throw new AmountNormalizationError("Provider amount must be a finite number.");
  }
  // Flip only when the provider treats outflow as positive.
  const normalized = convention === "outflow_positive" ? -rawAmount : rawAmount;
  assertImportedAmount(normalized);
  // Avoid a signed-zero artifact (e.g. -0) — assertImportedAmount already
  // rejects 0, this keeps the returned value canonical.
  return normalized + 0;
}

/** True for an inflow (deposit/credit) under the Xanther convention. */
export function isInflow(xantherAmount: number): boolean {
  return xantherAmount > 0;
}

/** True for an outflow (charge/debit) under the Xanther convention. */
export function isOutflow(xantherAmount: number): boolean {
  return xantherAmount < 0;
}
