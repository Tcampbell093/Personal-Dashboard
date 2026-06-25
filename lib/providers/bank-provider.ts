/* =============================================================================
 * Xanther — provider-neutral bank-connection contract (Finance 1B.0)
 *
 * The narrow interface every bank-aggregation provider adapter must implement.
 * Finance 1B is READ-ONLY and never moves money — there is deliberately no
 * payment/transfer/move-money method here. The internal finance domain depends
 * ONLY on this interface; the concrete adapter (e.g. a future Plaid adapter)
 * stays behind it and never leaks raw provider types.
 *
 * No adapter exists yet. This is a typed contract + documentation only: nothing
 * here imports an SDK, reads an env var at module load, calls a network, or
 * stores a credential. Do NOT add a speculative multi-provider registry — when
 * the Plaid adapter lands it simply `implements BankProvider`.
 * ===========================================================================*/

import type {
  ConnectionMetadata,
  CreateLinkSessionInput,
  LinkSession,
  ProviderAccessToken,
  ProviderAccount,
  ProviderBalance,
  PublicCredentialExchange,
  TransactionSyncPage,
  UpdateLinkSessionInput,
  VerifiedWebhook,
  WebhookVerificationInput,
} from "./types";

export interface BankProvider {
  /** Stable provider identifier, e.g. "plaid". Used for scoping + logging. */
  readonly providerName: string;

  /** Create a short-lived Link session for the browser to launch (connect). */
  createLinkSession(input: CreateLinkSessionInput): Promise<LinkSession>;

  /** Create a Link session in UPDATE/repair mode to re-authenticate an Item. */
  createUpdateLinkSession(input: UpdateLinkSessionInput): Promise<LinkSession>;

  /**
   * Exchange the browser's temporary public credential for a long-lived,
   * SECRET provider access token (+ non-secret connection id). The caller MUST
   * encrypt the token immediately (see `token-crypto.ts`) and never persist or
   * log it in plaintext.
   */
  exchangePublicCredential(input: { publicToken: string }): Promise<PublicCredentialExchange>;

  /** Non-secret connection metadata (institution, status). */
  getConnectionMetadata(access: ProviderAccessToken): Promise<ConnectionMetadata>;

  /** The accounts exposed by one connection (one connection → many accounts). */
  listAccounts(access: ProviderAccessToken): Promise<ProviderAccount[]>;

  /**
   * CACHED balances only. Finance 1B does not implement paid real-time balance
   * refresh; each balance carries an `asOf` for truthful freshness display.
   */
  getCachedBalances(access: ProviderAccessToken): Promise<ProviderBalance[]>;

  /**
   * One page of incremental transaction sync. `cursor` is null for the first
   * sync. The caller persists the page, then commits `nextCursor` only after a
   * successful write; on error it does NOT advance the cursor.
   */
  syncTransactions(access: ProviderAccessToken, cursor: string | null): Promise<TransactionSyncPage>;

  /** Revoke the provider connection (used on owner disconnect). */
  revokeConnection(access: ProviderAccessToken): Promise<void>;

  /**
   * Verify an incoming webhook is authentic and not a replay. Implementations
   * MUST reject (throw) unsigned/expired/tampered payloads and MUST NOT mutate
   * any financial truth — a webhook only signals that a controlled sync is due.
   */
  verifyWebhook(input: WebhookVerificationInput): Promise<VerifiedWebhook>;
}
