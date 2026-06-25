/* =============================================================================
 * Xanther — provider-neutral bank-integration DTOs (Finance 1B.0)
 *
 * READ-ONLY. Finance 1B never moves money. These are the ONLY shapes the rest of
 * the finance domain (services, matching, UI) is allowed to see. A provider
 * adapter (e.g. a future Plaid adapter under `lib/providers/plaid/`) MUST map its
 * raw responses into these DTOs and MUST NOT leak provider-native types, field
 * names, or sign conventions past this boundary.
 *
 * Nothing here connects to a provider, installs an SDK, stores a token, or makes
 * a network call. These are types + documentation only.
 * ===========================================================================*/

/**
 * A provider access token is a SECRET, server-only credential obtained when a
 * public credential is exchanged. It must be encrypted at rest immediately (see
 * `lib/providers/token-crypto.ts`) and decrypted only server-side, only
 * immediately before a provider call. It must never appear in browser code,
 * logs, errors, URLs, snapshots, or the repository. The branded type makes an
 * accidental plaintext-string assignment visible in review.
 */
export type ProviderAccessToken = string & { readonly __brand: "ProviderAccessToken" };

/** Health of one authenticated institution connection (provider-neutral). */
export type ConnectionStatus =
  | "active"
  | "login_required" // owner must re-authenticate (update/repair mode)
  | "pending_expiration"
  | "error"
  | "revoked";

/** A short-lived Link session the browser uses to launch the provider's UI. */
export interface LinkSession {
  /** Opaque, short-lived token the client SDK consumes. Not a stored secret. */
  readonly linkToken: string;
  /** ISO-8601 expiry; the client must launch before this. */
  readonly expiresAt: string;
}

export interface CreateLinkSessionInput {
  /** Owner id (single-owner app). */
  readonly userId: number;
  /** Registered HTTPS redirect URI, required for OAuth institutions. */
  readonly redirectUri?: string;
}

export interface UpdateLinkSessionInput {
  readonly userId: number;
  /** The existing connection being repaired/re-authenticated. */
  readonly providerItemId: string;
  readonly redirectUri?: string;
}

/** Result of exchanging the browser's temporary public credential. */
export interface PublicCredentialExchange {
  /** SECRET — encrypt before persisting; never store or log in plaintext. */
  readonly providerAccessToken: ProviderAccessToken;
  /** Non-secret provider connection id (Plaid `item_id`). Stored in clear. */
  readonly providerItemId: string;
}

/** Non-secret metadata about one connection. */
export interface ConnectionMetadata {
  readonly providerItemId: string;
  readonly institutionId: string | null;
  readonly institutionName: string | null;
  readonly status: ConnectionStatus;
}

/** A provider account discovered under a connection. IDs are connection-scoped. */
export interface ProviderAccount {
  /** Non-secret provider account id. Only trusted WITHIN its connection. */
  readonly providerAccountId: string;
  readonly mask: string | null; // last 4, display only
  readonly name: string;
  readonly officialName: string | null;
  readonly type: string | null; // provider-native, normalized to a string
  readonly subtype: string | null;
}

/**
 * A CACHED balance snapshot (Finance 1B uses cached balances only — no paid
 * real-time refresh in the initial version). `asOf` carries freshness so the UI
 * can show "last updated" truthfully and never imply live accuracy. Any field
 * may be null when the provider does not return it.
 */
export interface ProviderBalance {
  readonly providerAccountId: string;
  readonly current: number | null;
  readonly available: number | null;
  readonly isoCurrencyCode: string | null;
  /** ISO-8601 timestamp of when the provider last updated this balance. */
  readonly asOf: string | null;
}

/**
 * One imported transaction, already normalized to Xanther's canonical sign
 * convention (inflow positive, outflow negative — see `amount.ts`). This is
 * EVIDENCE of activity, never a Xanther balance command.
 */
export interface ImportedTransactionDTO {
  readonly providerTransactionId: string;
  readonly providerAccountId: string;
  /** Set on a POSTED transaction that replaced a pending one. */
  readonly pendingProviderTransactionId: string | null;
  readonly isPending: boolean;
  /** Xanther-signed amount: inflow > 0, outflow < 0, never 0. */
  readonly amount: number;
  readonly isoCurrencyCode: string | null;
  readonly descriptionOriginal: string;
  readonly merchantName: string | null;
  readonly authorizedDate: string | null; // ISO date
  readonly postedDate: string | null; // ISO date
  readonly categoryPrimary: string | null;
  readonly categoryDetailed: string | null;
}

/** A transaction the institution removed (tombstone, never hard-deleted). */
export interface RemovedTransactionRef {
  readonly providerTransactionId: string;
  readonly providerAccountId: string;
}

/**
 * One page of an incremental transaction sync. The caller paginates on
 * `hasMore`, persists each page, and commits `nextCursor` ONLY after the page is
 * durably stored. On any page error the whole loop restarts from the prior
 * committed cursor (no partial advancement).
 */
export interface TransactionSyncPage {
  readonly added: ImportedTransactionDTO[];
  readonly modified: ImportedTransactionDTO[];
  readonly removed: RemovedTransactionRef[];
  readonly nextCursor: string;
  readonly hasMore: boolean;
}

/** Input to webhook verification — raw, untrusted until verified. */
export interface WebhookVerificationInput {
  readonly headers: Readonly<Record<string, string>>;
  /** Raw, unparsed request body (verification is whitespace-sensitive). */
  readonly rawBody: string;
}

/** A webhook that passed authenticity + replay checks. */
export interface VerifiedWebhook {
  readonly providerItemId: string;
  readonly webhookType: string;
  readonly webhookCode: string;
  readonly verified: true;
}
