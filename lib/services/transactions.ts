/* =============================================================================
 * Xanther — imported-transaction service (Finance 1B.3A, server-only)
 *
 * Manual incremental transaction sync from a bank provider (Plaid Sandbox).
 * Imported transactions are BANK EVIDENCE, NOT Xanther commands: this service
 * NEVER writes an `account_movements` row, never mutates a provider/manual
 * balance, and never confirms a bill/income/transfer. Sandbox + read-only.
 *
 * Atomic fetch → buffer → commit (Finance 1B.3A correction). Per Plaid's
 * pagination guidance, the ENTIRE page sequence is fetched into memory FIRST
 * (no durable writes). A `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` discards
 * the in-memory accumulation and restarts from the ORIGINAL committed cursor
 * (bounded retries). Only once every page has succeeded is the complete patch
 * (added/modified upserts + removed tombstones) applied together with the final
 * cursor + success timestamp in ONE database statement (a writable CTE — neon-http
 * has no interactive transactions, so a single statement IS the atomic unit). Any
 * failure (provider, page-limit, normalization, or the apply itself) persists no
 * patch and preserves the prior cursor + prior success timestamp.
 * ===========================================================================*/

// Server-only (db + token decryption + provider calls).
if (typeof window !== "undefined") {
  throw new Error("transactions service is server-only and must not be imported in the browser.");
}

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { financialAccounts, financialConnections, importedTransactions, providerAccounts } from "@/db/schema";
import { plaidAdapter } from "@/lib/providers/plaid/adapter";
import { decryptToken, resolveMasterKeyFromEnv } from "@/lib/providers/token-crypto";
import type { BankProvider } from "@/lib/providers/bank-provider";
import { MutationDuringPaginationError } from "@/lib/providers/types";
import type { ImportedTransactionDTO, ProviderAccessToken } from "@/lib/providers/types";
import type { ImportedTransactionView } from "@/lib/types";
import { ConnectionError } from "./connections";

const MAX_PAGES = 25; // bounded per manual sync
const MAX_MUTATION_RETRIES = 5; // bounded restarts on TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION
type SyncProvider = Pick<BankProvider, "syncTransactions">;
type TxRow = typeof importedTransactions.$inferSelect;

/** Internal: the configured page limit was reached while the provider still had more pages. */
class PageLimitError extends Error {
  constructor() { super("Transaction sync exceeded the page limit before completing."); this.name = "PageLimitError"; }
}

export interface SyncResult {
  added: number; // raw added returned by the provider (pre-dedup)
  modified: number; // raw modified
  removed: number; // tombstoned rows that matched
  skippedUnknownRemoval: number; // removals for ids not present (documented rule)
  pages: number;
  retries: number; // mutation-during-pagination restarts used
}

type Upsert = { dto: ImportedTransactionDTO; faId: number | null };
interface Patch { upserts: Upsert[]; removedIds: string[]; finalCursor: string | null; rawAdded: number; rawModified: number; pages: number; }

/**
 * Fetch EVERY available page into memory and aggregate the complete normalized
 * patch — WITHOUT any durable write. Throws MutationDuringPaginationError (caller
 * restarts), PageLimitError (fail closed), or a provider/normalization error.
 */
async function fetchCompletePatch(provider: SyncProvider, token: ProviderAccessToken, startCursor: string | null, accountMap: Map<string, number | null>): Promise<Patch> {
  let cursor = startCursor;
  let rawAdded = 0, rawModified = 0, pages = 0;
  // Ordered events preserve provider ordering across pages (later = more recent).
  const events: { kind: "upsert" | "remove"; id: string; dto?: ImportedTransactionDTO }[] = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const pageData = await provider.syncTransactions(token, cursor); // may throw (incl. MutationDuringPaginationError)
    for (const t of pageData.added) { events.push({ kind: "upsert", id: t.providerTransactionId, dto: t }); rawAdded++; }
    for (const t of pageData.modified) { events.push({ kind: "upsert", id: t.providerTransactionId, dto: t }); rawModified++; }
    for (const r of pageData.removed) { if (r.providerTransactionId) events.push({ kind: "remove", id: r.providerTransactionId }); }
    cursor = pageData.nextCursor;
    pages++;
    if (!pageData.hasMore) {
      // Aggregate deterministically: last event per id wins; upsert and remove are
      // mutually exclusive (a txn in both categories resolves to its LAST event).
      const upsertMap = new Map<string, ImportedTransactionDTO>();
      const removeSet = new Set<string>();
      for (const ev of events) {
        if (ev.kind === "upsert") { upsertMap.set(ev.id, ev.dto!); removeSet.delete(ev.id); }
        else { removeSet.add(ev.id); upsertMap.delete(ev.id); }
      }
      const upserts: Upsert[] = [...upsertMap.values()].map((dto) => ({ dto, faId: accountMap.get(dto.providerAccountId) ?? null }));
      return { upserts, removedIds: [...removeSet], finalCursor: cursor, rawAdded, rawModified, pages };
    }
  }
  throw new PageLimitError(); // hasMore still true after MAX_PAGES → fail closed
}

/**
 * Apply the COMPLETE patch (upserts + tombstones), the final cursor, the success
 * timestamp, and the cleared error state in ONE writable-CTE statement. A single
 * statement is atomic: if any part fails, Postgres rolls the whole thing back, so
 * no partial patch and no cursor/timestamp advance can survive a failure.
 */
async function applyPatchAtomic(userId: number, connectionId: number, upserts: Upsert[], removedIds: string[], finalCursor: string | null) {
  const ctes = [];
  if (upserts.length) {
    const rows = sql.join(
      upserts.map(({ dto, faId }) => sql`(${userId}, ${connectionId}, ${dto.providerAccountId}, ${faId}, 'plaid', ${dto.providerTransactionId}, ${dto.pendingProviderTransactionId}, 'active', ${dto.isPending}, ${String(dto.amount)}, ${dto.isoCurrencyCode}, ${dto.descriptionOriginal}, ${dto.descriptionCurrent}, ${dto.merchantName}, ${dto.authorizedDate}, ${dto.postedDate}, ${dto.categoryPrimary}, ${dto.categoryDetailed}, now(), now())`),
      sql`, `,
    );
    ctes.push(sql`ins AS (
      INSERT INTO imported_transactions (user_id, connection_id, provider_account_id, financial_account_id, provider, provider_transaction_id, pending_provider_transaction_id, status, is_pending, amount, currency_code, description_original, description_current, merchant_name, authorized_date, posted_date, category_primary, category_detailed, first_seen_at, last_updated_at)
      VALUES ${rows}
      ON CONFLICT (connection_id, provider_transaction_id) DO UPDATE SET
        financial_account_id = EXCLUDED.financial_account_id, pending_provider_transaction_id = EXCLUDED.pending_provider_transaction_id,
        status = 'active', is_pending = EXCLUDED.is_pending, amount = EXCLUDED.amount, currency_code = EXCLUDED.currency_code,
        description_original = EXCLUDED.description_original, description_current = EXCLUDED.description_current, merchant_name = EXCLUDED.merchant_name,
        authorized_date = EXCLUDED.authorized_date, posted_date = EXCLUDED.posted_date, category_primary = EXCLUDED.category_primary,
        category_detailed = EXCLUDED.category_detailed, removed_at = NULL, last_updated_at = now(), updated_at = now()
      RETURNING id)`);
  }
  if (removedIds.length) {
    const ids = sql.join(removedIds.map((id) => sql`${id}`), sql`, `);
    ctes.push(sql`rem AS (
      UPDATE imported_transactions SET status = 'removed', removed_at = COALESCE(removed_at, now()), last_updated_at = now(), updated_at = now()
      WHERE user_id = ${userId} AND connection_id = ${connectionId} AND provider_transaction_id IN (${ids})
      RETURNING id)`);
  }
  ctes.push(sql`conn AS (
    UPDATE financial_connections SET transactions_cursor = ${finalCursor}, last_transaction_synced_at = now(),
      transaction_sync_error_code = NULL, transaction_sync_error_message = NULL, updated_at = now()
    WHERE id = ${connectionId} AND user_id = ${userId}
    RETURNING id)`);
  const upserted = upserts.length ? sql`(SELECT count(*)::int FROM ins)` : sql`0`;
  const removedMatched = removedIds.length ? sql`(SELECT count(*)::int FROM rem)` : sql`0`;
  const res = await db.execute(sql`WITH ${sql.join(ctes, sql`, `)} SELECT ${upserted} AS upserted, ${removedMatched} AS removed_matched, (SELECT count(*)::int FROM conn) AS conn_updated`);
  return res.rows[0] as { upserted: number; removed_matched: number; conn_updated: number };
}

async function recordSyncError(userId: number, connectionId: number, code: string) {
  // Bounded error state only — preserves the cursor + last successful timestamp.
  await db
    .update(financialConnections)
    .set({ transactionSyncErrorCode: code, transactionSyncErrorMessage: "Transaction sync did not complete; will retry.", updatedAt: new Date() })
    .where(and(eq(financialConnections.id, connectionId), eq(financialConnections.userId, userId)));
}

/**
 * Run a bounded, atomic incremental transaction sync for one connection. Owner-
 * scoped + Sandbox-only. `opts.provider` injects a fake provider for tests.
 */
export async function syncConnectionTransactions(userId: number, connectionId: number, opts?: { provider?: SyncProvider }): Promise<SyncResult> {
  const provider = opts?.provider ?? plaidAdapter;

  const [conn] = await db
    .select()
    .from(financialConnections)
    .where(and(eq(financialConnections.id, connectionId), eq(financialConnections.userId, userId), isNull(financialConnections.deletedAt)));
  if (!conn) throw new ConnectionError(404, "Connection not found.");
  if (conn.environment !== "sandbox") throw new ConnectionError(400, "Only Sandbox connections can sync transactions in this phase.");

  // Per-connection DB lock (not a button-disable): claim atomically; stale (>5 min) reclaimable.
  const claim = await db.execute(sql`
    UPDATE financial_connections
    SET transaction_sync_locked_at = now(), last_transaction_sync_attempted_at = now(), updated_at = now()
    WHERE id = ${connectionId} AND user_id = ${userId}
      AND (transaction_sync_locked_at IS NULL OR transaction_sync_locked_at < now() - interval '5 minutes')
    RETURNING id
  `);
  if (!claim.rows.length) throw new ConnectionError(409, "A transaction sync is already in progress for this connection.");

  try {
    const key = resolveMasterKeyFromEnv(1);
    if (!key) throw new ConnectionError(503, "Bank token encryption is not configured.");
    let token: ProviderAccessToken;
    try {
      token = decryptToken({ v: conn.accessTokenEnvelopeVersion, keyVersion: conn.accessTokenKeyVersion, nonce: conn.accessTokenNonce, ciphertext: conn.accessTokenCipher, tag: conn.accessTokenTag }, key) as ProviderAccessToken;
    } catch {
      throw new ConnectionError(500, "Could not access the bank connection."); // writes nothing
    }

    const pas = await db.select().from(providerAccounts).where(and(eq(providerAccounts.connectionId, connectionId), eq(providerAccounts.userId, userId)));
    const accountMap = new Map<string, number | null>(pas.map((p) => [p.providerAccountId, p.financialAccountId]));

    // The original committed cursor is preserved for the entire attempt; every
    // retry restarts the WHOLE fetch from it (no durable writes happen in between).
    const startCursor = conn.transactionsCursor ?? null;

    let patch: Patch | null = null;
    let retries = 0;
    for (;;) {
      try {
        patch = await fetchCompletePatch(provider, token, startCursor, accountMap);
        break;
      } catch (e) {
        if (e instanceof MutationDuringPaginationError) {
          if (retries < MAX_MUTATION_RETRIES) { retries++; continue; } // restart from startCursor — nothing persisted
          await recordSyncError(userId, connectionId, "SYNC_MUTATION_RETRY_EXHAUSTED");
          throw new ConnectionError(503, "Transaction sync could not complete because bank data kept changing; please try again.");
        }
        if (e instanceof PageLimitError) {
          await recordSyncError(userId, connectionId, "SYNC_INCOMPLETE_PAGE_LIMIT");
          throw new ConnectionError(422, "Transaction sync was incomplete (too many pages); please try again.");
        }
        await recordSyncError(userId, connectionId, "SYNC_FAILED");
        throw e instanceof ConnectionError ? e : new ConnectionError(502, "Transaction sync did not complete.");
      }
    }

    // Apply the complete patch + cursor + timestamp atomically (one statement).
    let result;
    try {
      result = await applyPatchAtomic(userId, connectionId, patch.upserts, patch.removedIds, patch.finalCursor);
    } catch {
      await recordSyncError(userId, connectionId, "SYNC_APPLY_FAILED"); // rollback already happened; cursor + timestamp preserved
      throw new ConnectionError(500, "Could not store the synced transactions.");
    }

    return {
      added: patch.rawAdded,
      modified: patch.rawModified,
      removed: result.removed_matched,
      skippedUnknownRemoval: patch.removedIds.length - result.removed_matched,
      pages: patch.pages,
      retries,
    };
  } finally {
    await db.update(financialConnections).set({ transactionSyncLockedAt: null }).where(and(eq(financialConnections.id, connectionId), eq(financialConnections.userId, userId)));
  }
}

export interface TransactionFilters {
  financialAccountId?: number | null;
  isPending?: boolean;
  status?: "active" | "removed" | "all";
  limit?: number;
}

/** Owner-scoped nonsecret transaction views. Default: ACTIVE only, with pending
 * rows superseded by a posted replacement suppressed (no double-counting). */
export async function listImportedTransactions(userId: number, filters: TransactionFilters = {}): Promise<ImportedTransactionView[]> {
  const conds = [eq(importedTransactions.userId, userId), isNull(importedTransactions.deletedAt)];
  if (!filters.status || filters.status === "active") conds.push(eq(importedTransactions.status, "active"));
  else if (filters.status === "removed") conds.push(eq(importedTransactions.status, "removed"));
  if (filters.financialAccountId !== undefined) {
    conds.push(filters.financialAccountId === null ? isNull(importedTransactions.financialAccountId) : eq(importedTransactions.financialAccountId, filters.financialAccountId));
  }
  if (filters.isPending !== undefined) conds.push(eq(importedTransactions.isPending, filters.isPending));

  const rows = await db
    .select()
    .from(importedTransactions)
    .where(and(...conds))
    // Deterministic ordering: newest first, with a STABLE id tie-breaker so equal
    // dates/created-at never reorder between renders.
    .orderBy(desc(importedTransactions.postedDate), desc(importedTransactions.authorizedDate), desc(importedTransactions.createdAt), desc(importedTransactions.id))
    .limit(Math.min(filters.limit ?? 100, 500));

  const supersededPending = new Set(
    rows.filter((r) => r.status === "active" && !r.isPending && r.pendingProviderTransactionId).map((r) => r.pendingProviderTransactionId as string),
  );
  const visible = rows.filter((r) => !(r.isPending && supersededPending.has(r.providerTransactionId)));
  return mapTransactionViews(userId, visible);
}

async function mapTransactionViews(userId: number, rows: TxRow[]): Promise<ImportedTransactionView[]> {
  const accts = await db.select({ id: financialAccounts.id, name: financialAccounts.name }).from(financialAccounts).where(eq(financialAccounts.userId, userId));
  const nameById = new Map(accts.map((a) => [a.id, a.name]));
  return rows.map((r) => ({
    id: r.id,
    financialAccountId: r.financialAccountId,
    accountLabel: r.financialAccountId != null ? (nameById.get(r.financialAccountId) ?? "Linked account") : "Not added to Xanther",
    mapped: r.financialAccountId != null,
    amount: Number(r.amount),
    currencyCode: r.currencyCode,
    isPending: r.isPending,
    status: r.status,
    descriptionCurrent: r.descriptionCurrent,
    merchantName: r.merchantName,
    authorizedDate: r.authorizedDate,
    postedDate: r.postedDate,
    date: r.postedDate ?? r.authorizedDate,
    categoryPrimary: r.categoryPrimary,
  }));
}

/** Bounded transaction-sync status for a connection (nonsecret). */
export async function getTransactionSyncStatus(userId: number, connectionId: number) {
  const [c] = await db
    .select({
      lastTransactionSyncedAt: financialConnections.lastTransactionSyncedAt,
      lastTransactionSyncAttemptedAt: financialConnections.lastTransactionSyncAttemptedAt,
      errorCode: financialConnections.transactionSyncErrorCode,
    })
    .from(financialConnections)
    .where(and(eq(financialConnections.id, connectionId), eq(financialConnections.userId, userId)));
  return c ?? null;
}
