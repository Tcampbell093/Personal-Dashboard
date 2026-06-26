/* =============================================================================
 * Xanther — bank-connection service (Finance 1B.1, server-only)
 *
 * Orchestrates the Sandbox connect flow behind the routes: create a Link
 * session, exchange a public token, encrypt the access token, and store a
 * bounded connection row. READ-ONLY — no accounts, balances, transactions, or
 * money movement. The plaintext access token is encrypted immediately and never
 * written to the database, returned, or logged.
 * ===========================================================================*/

// Server-only (db + Plaid + token encryption).
if (typeof window !== "undefined") {
  throw new Error("connections service is server-only and must not be imported in the browser.");
}

import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { financialConnections, providerAccounts } from "@/db/schema";
import { plaidAdapter } from "@/lib/providers/plaid/adapter";
import { sandboxReadiness } from "@/lib/providers/plaid/env";
import { encryptToken, decryptToken, resolveMasterKeyFromEnv } from "@/lib/providers/token-crypto";
import type { ProviderAccessToken } from "@/lib/providers/types";
import type { ConnectionView } from "@/lib/types";

const PROVIDER = "plaid";
type ConnectionRow = typeof financialConnections.$inferSelect;

export class ConnectionError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ConnectionError";
    this.status = status;
  }
}

function masterKey() {
  const key = resolveMasterKeyFromEnv(1);
  if (!key) throw new ConnectionError(503, "Bank token encryption is not configured.");
  return key;
}

/** Strip every secret/encrypted field → a nonsecret view safe for any response. */
export function toConnectionView(row: ConnectionRow): ConnectionView {
  return {
    id: row.id,
    provider: row.provider,
    institutionId: row.institutionId,
    institutionName: row.institutionName ?? "Connected institution",
    status: row.status,
    environment: row.environment,
    requiresReauth: row.requiresReauth,
    connectedAt: (row.consentGrantedAt ?? row.createdAt)?.toISOString() ?? null,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
    lastTransactionSyncedAt: row.lastTransactionSyncedAt ? row.lastTransactionSyncedAt.toISOString() : null,
  };
}

async function findActive(userId: number, providerItemId: string): Promise<ConnectionRow | null> {
  const rows = await db
    .select()
    .from(financialConnections)
    .where(
      and(
        eq(financialConnections.userId, userId),
        eq(financialConnections.provider, PROVIDER),
        eq(financialConnections.providerItemId, providerItemId),
        isNull(financialConnections.deletedAt),
      ),
    );
  return rows[0] ?? null;
}

/** Create a short-lived Plaid Link session. Sandbox env is enforced in the adapter. */
export async function createLinkSession(userId: number) {
  return plaidAdapter.createLinkSession({ userId });
}

/**
 * Exchange a public token and store ONE encrypted connection. Idempotent +
 * fail-closed:
 *  - a repeated/duplicate Item returns the existing nonsecret view (no 2nd row);
 *  - a Plaid failure or an encryption failure writes NOTHING;
 *  - the plaintext token is encrypted before any DB write and never logged.
 * Never accepts a user id from the caller's request body — `userId` is the
 * server-resolved owner.
 */
export async function exchangeAndStore(userId: number, publicToken: string): Promise<ConnectionView> {
  if (typeof publicToken !== "string" || publicToken.trim() === "") {
    throw new ConnectionError(400, "A public token is required.");
  }

  // 1. Exchange (Plaid). On failure: throw before any DB write — nothing stored.
  let providerAccessToken: ProviderAccessToken;
  let providerItemId: string;
  try {
    const ex = await plaidAdapter.exchangePublicCredential({ publicToken });
    providerAccessToken = ex.providerAccessToken;
    providerItemId = ex.providerItemId;
  } catch {
    // Never echo the Plaid error (it could reference the public token).
    throw new ConnectionError(502, "Could not exchange the public token with the provider.");
  }

  // 2. Idempotency: an existing connection for this Item → return it (retry-safe).
  const existing = await findActive(userId, providerItemId);
  if (existing) return toConnectionView(existing);

  // 3. Bounded institution metadata (best-effort; failure is non-fatal).
  let institutionId: string | null = null;
  let institutionName: string | null = null;
  try {
    const meta = await plaidAdapter.getConnectionMetadata(providerAccessToken);
    institutionId = meta.institutionId;
    institutionName = meta.institutionName;
  } catch {
    institutionId = null;
    institutionName = null;
  }

  // 4. Encrypt the access token. Failure here writes NOTHING (throws first).
  let envelope;
  try {
    envelope = encryptToken(providerAccessToken, masterKey());
  } catch {
    throw new ConnectionError(500, "Could not secure the bank connection.");
  }

  // 5. Insert atomically; the unique index collapses a concurrent duplicate.
  try {
    const [row] = await db
      .insert(financialConnections)
      .values({
        userId,
        provider: PROVIDER,
        providerItemId,
        institutionId,
        institutionName,
        accessTokenCipher: envelope.ciphertext,
        accessTokenNonce: envelope.nonce,
        accessTokenTag: envelope.tag,
        accessTokenKeyVersion: envelope.keyVersion,
        accessTokenEnvelopeVersion: envelope.v,
        status: "active",
        environment: "sandbox",
        consentGrantedAt: new Date(),
      })
      .onConflictDoNothing({
        target: [financialConnections.userId, financialConnections.provider, financialConnections.providerItemId],
      })
      .returning();
    if (row) return toConnectionView(row);
    // Concurrent insert won the race → return the now-existing row.
    const again = await findActive(userId, providerItemId);
    if (again) return toConnectionView(again);
    throw new ConnectionError(500, "Could not store the bank connection.");
  } catch (e) {
    if (e instanceof ConnectionError) throw e;
    // Never log or return the token on a storage failure.
    throw new ConnectionError(500, "Could not store the bank connection.");
  }
  // The plaintext token leaves scope here — never persisted, returned, or logged.
}

/** Owner-scoped nonsecret connection list (no encrypted fields, ever). */
export async function listConnections(userId: number): Promise<ConnectionView[]> {
  const rows = await db
    .select()
    .from(financialConnections)
    .where(and(eq(financialConnections.userId, userId), isNull(financialConnections.deletedAt)))
    .orderBy(desc(financialConnections.createdAt));
  return rows.map(toConnectionView);
}

/**
 * Sandbox cleanup: revoke the Plaid Item (best-effort) and delete ONLY this
 * connection row. Owner-scoped; touches no account, movement, bill, income, or
 * transfer. Returns whether a row was removed.
 */
export async function deleteConnection(userId: number, id: number): Promise<{ deleted: boolean }> {
  const rows = await db
    .select()
    .from(financialConnections)
    .where(and(eq(financialConnections.id, id), eq(financialConnections.userId, userId)));
  const row = rows[0];
  if (!row) return { deleted: false };

  // Finance 1B.2 correction: a connection with ANY linked provider account cannot
  // be hard-deleted — that would orphan a `linked` Xanther account. Reject with a
  // bounded conflict (mutating nothing). The DB FK (NO ACTION) + the guarded CTE
  // below are the race backstop. No token or provider id is exposed in the error.
  const mapped = await db
    .select({ id: providerAccounts.id })
    .from(providerAccounts)
    .where(and(eq(providerAccounts.connectionId, id), eq(providerAccounts.userId, userId), isNotNull(providerAccounts.financialAccountId)));
  if (mapped.length) throw new ConnectionError(409, "This connection has linked Xanther accounts and cannot be removed yet.");

  // Best-effort provider revoke; a revoke failure must not block deleting our row.
  try {
    const key = resolveMasterKeyFromEnv(1);
    if (key) {
      const token = decryptToken(
        {
          v: row.accessTokenEnvelopeVersion,
          keyVersion: row.accessTokenKeyVersion,
          nonce: row.accessTokenNonce,
          ciphertext: row.accessTokenCipher,
          tag: row.accessTokenTag,
        },
        key,
      ) as string;
      await plaidAdapter.revokeConnection(token as ProviderAccessToken);
    }
  } catch {
    /* ignore revoke failure — still remove our local row */
  }

  // Atomic + race-safe: delete the UNMAPPED provider-account snapshots + the
  // connection only if no provider account is mapped. If a concurrent
  // create-linked maps one between the pre-check and here, the connection DELETE
  // violates the NO ACTION FK and the whole statement aborts → nothing deleted,
  // no orphan.
  try {
    const res = await db.execute(sql`
      WITH guard AS (
        SELECT 1 FROM provider_accounts
        WHERE connection_id = ${id} AND user_id = ${userId} AND financial_account_id IS NOT NULL LIMIT 1
      ),
      del_pa AS (
        DELETE FROM provider_accounts
        WHERE connection_id = ${id} AND user_id = ${userId} AND financial_account_id IS NULL AND NOT EXISTS (SELECT 1 FROM guard)
        RETURNING id
      ),
      del_conn AS (
        DELETE FROM financial_connections
        WHERE id = ${id} AND user_id = ${userId} AND NOT EXISTS (SELECT 1 FROM guard)
        RETURNING id
      )
      SELECT (SELECT count(*)::int FROM guard) AS mapped, (SELECT count(*)::int FROM del_conn) AS deleted
    `);
    const r = res.rows[0] as { mapped: number; deleted: number };
    if (Number(r.mapped) > 0) throw new ConnectionError(409, "This connection has linked Xanther accounts and cannot be removed yet.");
    return { deleted: Number(r.deleted) > 0 };
  } catch (e) {
    if (e instanceof ConnectionError) throw e;
    // A concurrent linked-account creation made the connection un-deletable (FK).
    throw new ConnectionError(409, "This connection has linked Xanther accounts and cannot be removed yet.");
  }
}

/** Re-export the nonsecret readiness probe (names-only). */
export { sandboxReadiness };
