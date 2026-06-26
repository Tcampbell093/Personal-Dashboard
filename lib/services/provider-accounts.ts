/* =============================================================================
 * Xanther — provider-account discovery + cached balances (Finance 1B.2, server-only)
 *
 * Read-only. Discovers Plaid Sandbox accounts for an existing connection, stores
 * CACHED balances + freshness, and lets the owner create a NEW linked Xanther
 * account from an unmapped provider account. It NEVER maps onto an existing
 * manual account, edits a manual balance, moves money, or syncs transactions.
 * The decrypted access token never leaves the provider-call boundary.
 * ===========================================================================*/

// Server-only.
if (typeof window !== "undefined") {
  throw new Error("provider-accounts service is server-only and must not be imported in the browser.");
}

import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { financialAccounts, financialConnections, providerAccounts } from "@/db/schema";
import { plaidAdapter } from "@/lib/providers/plaid/adapter";
import { decryptToken, resolveMasterKeyFromEnv } from "@/lib/providers/token-crypto";
import type { ProviderAccessToken } from "@/lib/providers/types";
import { ConnectionError } from "@/lib/services/connections";
import { ACCOUNT_PURPOSES, isLiabilityType, num, type LinkedSnapshot } from "@/lib/services/finances";
import type { ProviderAccountView } from "@/lib/types";

const PROVIDER = "plaid";
type ProviderAccountRow = typeof providerAccounts.$inferSelect;
type ConnectionRow = typeof financialConnections.$inferSelect;

function masterKey() {
  const key = resolveMasterKeyFromEnv(1);
  if (!key) throw new ConnectionError(503, "Bank token encryption is not configured.");
  return key;
}

/** Owner-scoped connection load (foreign/unknown → null). */
async function loadConnection(userId: number, connectionId: number): Promise<ConnectionRow | null> {
  const rows = await db
    .select()
    .from(financialConnections)
    .where(and(eq(financialConnections.id, connectionId), eq(financialConnections.userId, userId), isNull(financialConnections.deletedAt)));
  return rows[0] ?? null;
}

export function toProviderAccountView(row: ProviderAccountRow, linkedName: string | null = null): ProviderAccountView {
  return {
    id: row.id,
    connectionId: row.connectionId,
    provider: row.provider,
    mask: row.mask ?? null,
    providerName: row.providerName,
    officialName: row.officialName ?? null,
    type: row.providerType,
    subtype: row.providerSubtype ?? null,
    currency: row.currencyCode ?? null,
    balanceCurrent: row.balanceCurrent == null ? null : num(row.balanceCurrent),
    balanceAvailable: row.balanceAvailable == null ? null : num(row.balanceAvailable),
    balanceAsOf: row.balanceAsOf ? row.balanceAsOf.toISOString() : null,
    status: row.status,
    mapped: row.financialAccountId != null,
    financialAccountId: row.financialAccountId ?? null,
    linkedAccountName: linkedName,
  };
}

/** List discovered provider accounts for a connection (owner-scoped, nonsecret). */
export async function listProviderAccounts(userId: number, connectionId: number): Promise<ProviderAccountView[]> {
  const conn = await loadConnection(userId, connectionId);
  if (!conn) throw new ConnectionError(404, "Connection not found.");
  const rows = await db
    .select()
    .from(providerAccounts)
    .where(and(eq(providerAccounts.userId, userId), eq(providerAccounts.connectionId, connectionId), isNull(providerAccounts.deletedAt)));
  const linkedNames = await linkedNameMap(rows);
  return rows.map((r) => toProviderAccountView(r, r.financialAccountId ? linkedNames.get(r.financialAccountId) ?? null : null));
}

async function linkedNameMap(rows: ProviderAccountRow[]): Promise<Map<number, string>> {
  const ids = rows.map((r) => r.financialAccountId).filter((x): x is number => x != null);
  const map = new Map<number, string>();
  if (!ids.length) return map;
  for (const a of await db.select().from(financialAccounts).where(inArray(financialAccounts.id, ids))) map.set(a.id, a.name);
  return map;
}

/**
 * Discover + cache provider accounts for a connection. Idempotent upsert by
 * (connectionId, providerAccountId); previously-seen accounts now missing become
 * `stale` (never deleted). Fail-closed: a decryption failure writes no account
 * data; a provider failure preserves prior rows + the prior `lastSyncedAt`.
 */
export async function syncProviderAccounts(userId: number, connectionId: number): Promise<ProviderAccountView[]> {
  const conn = await loadConnection(userId, connectionId);
  if (!conn) throw new ConnectionError(404, "Connection not found.");
  if (conn.environment !== "sandbox") throw new ConnectionError(400, "Only Sandbox connections can be synced in this phase.");

  // Record the attempt truthfully (metadata only — no account data yet).
  await db.update(financialConnections).set({ lastSyncAttemptedAt: new Date(), updatedAt: new Date() }).where(eq(financialConnections.id, connectionId));

  // Decrypt server-side. Failure → write no account data.
  let token: ProviderAccessToken;
  try {
    token = decryptToken(
      {
        v: conn.accessTokenEnvelopeVersion,
        keyVersion: conn.accessTokenKeyVersion,
        nonce: conn.accessTokenNonce,
        ciphertext: conn.accessTokenCipher,
        tag: conn.accessTokenTag,
      },
      masterKey(),
    ) as ProviderAccessToken;
  } catch {
    throw new ConnectionError(500, "Could not access the secured bank connection.");
  }

  // Provider call. Failure → throw; prior rows + lastSyncedAt preserved.
  let accounts, balances;
  try {
    [accounts, balances] = await Promise.all([plaidAdapter.listAccounts(token), plaidAdapter.getCachedBalances(token)]);
  } catch {
    throw new ConnectionError(502, "Could not retrieve accounts from the provider.");
  }
  const balById = new Map(balances.map((b) => [b.providerAccountId, b]));

  const now = new Date();
  const seen: string[] = [];
  for (const a of accounts) {
    const bal = balById.get(a.providerAccountId);
    seen.push(a.providerAccountId);
    await db
      .insert(providerAccounts)
      .values({
        userId,
        connectionId,
        provider: PROVIDER,
        providerAccountId: a.providerAccountId,
        providerName: a.name,
        officialName: a.officialName,
        mask: a.mask,
        providerType: a.type ?? "other",
        providerSubtype: a.subtype,
        currencyCode: bal?.isoCurrencyCode ?? null,
        balanceCurrent: bal?.current == null ? null : String(bal.current),
        balanceAvailable: bal?.available == null ? null : String(bal.available),
        balanceLimit: null,
        balanceAsOf: now,
        status: "active",
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: [providerAccounts.connectionId, providerAccounts.providerAccountId],
        set: {
          providerName: a.name,
          officialName: a.officialName,
          mask: a.mask,
          providerType: a.type ?? "other",
          providerSubtype: a.subtype,
          currencyCode: bal?.isoCurrencyCode ?? null,
          balanceCurrent: bal?.current == null ? null : String(bal.current),
          balanceAvailable: bal?.available == null ? null : String(bal.available),
          balanceAsOf: now,
          status: "active",
          lastSeenAt: now,
          updatedAt: now,
        },
      });
  }

  // Previously-seen accounts missing from this sync → stale (retained).
  const existing = await db
    .select()
    .from(providerAccounts)
    .where(and(eq(providerAccounts.connectionId, connectionId), isNull(providerAccounts.deletedAt)));
  for (const row of existing) {
    if (!seen.includes(row.providerAccountId) && row.status !== "stale") {
      await db.update(providerAccounts).set({ status: "stale", updatedAt: now }).where(eq(providerAccounts.id, row.id));
    }
  }

  // Mark the sync successful.
  await db.update(financialConnections).set({ lastSyncedAt: now, updatedAt: now }).where(eq(financialConnections.id, connectionId));

  return listProviderAccounts(userId, connectionId);
}

export interface CreateLinkedInput {
  name: string;
  purpose: string;
  includeInSpendable: boolean;
}

/**
 * Create a NEW linked Xanther account from an unmapped provider account. Atomic +
 * idempotent: a single writable CTE inserts the financial_accounts row AND maps
 * the provider account only if it is currently unmapped, so a duplicate/concurrent
 * call never creates a second account. `balanceSource='linked'`; `currentBalance`
 * is left NULL (the provider snapshot is authoritative, not an editable field).
 * Credit accounts can never be spendable. Never maps onto an existing manual account.
 */
export async function createLinkedAccount(userId: number, providerAccountId: number, input: CreateLinkedInput): Promise<{ financialAccountId: number }> {
  const name = (input.name ?? "").trim();
  if (!name) throw new ConnectionError(400, "Account name is required.");
  const purpose = (ACCOUNT_PURPOSES as readonly string[]).includes(input.purpose) ? input.purpose : "other";

  const rows = await db
    .select()
    .from(providerAccounts)
    .where(and(eq(providerAccounts.id, providerAccountId), eq(providerAccounts.userId, userId), isNull(providerAccounts.deletedAt)));
  const pa = rows[0];
  if (!pa) throw new ConnectionError(404, "Provider account not found.");
  if (pa.financialAccountId != null) throw new ConnectionError(409, "This provider account is already linked.");

  const type = pa.providerType || "other";
  // Credit is never spendable; otherwise honor the owner's choice.
  const spendable = isLiabilityType(type) ? false : Boolean(input.includeInSpendable);
  const conn = await loadConnection(userId, pa.connectionId);
  const institution = conn?.institutionName ?? null;

  // Insert the linked account, then atomically CLAIM the mapping with a guarded
  // UPDATE (`financial_account_id IS NULL` = the serialization point / row lock).
  // If the claim loses a race, roll back the just-created account so a duplicate/
  // concurrent call leaves exactly ONE Xanther account (no half-mapped row).
  const [acct] = await db
    .insert(financialAccounts)
    .values({
      userId,
      name,
      type,
      institution,
      purpose,
      currentBalance: null, // linked: provider snapshot is authoritative, not an editable field
      balanceSource: "linked",
      includeInSpendable: spendable,
      active: true,
    })
    .returning();
  try {
    const claimed = await db
      .update(providerAccounts)
      .set({ financialAccountId: acct.id, updatedAt: new Date() })
      .where(and(eq(providerAccounts.id, providerAccountId), eq(providerAccounts.userId, userId), isNull(providerAccounts.financialAccountId)))
      .returning({ id: providerAccounts.id });
    if (!claimed.length) {
      // Lost the race (already linked) → undo the orphan account.
      await db.delete(financialAccounts).where(eq(financialAccounts.id, acct.id));
      throw new ConnectionError(409, "This provider account is already linked.");
    }
  } catch (e) {
    if (e instanceof ConnectionError) throw e;
    await db.delete(financialAccounts).where(eq(financialAccounts.id, acct.id)).catch(() => {});
    throw new ConnectionError(500, "Could not create the linked account.");
  }
  return { financialAccountId: acct.id };
}

/**
 * Exact-ID Sandbox cleanup for a TEMPORARY linked account created in this phase.
 * Owner-scoped; removes ONLY the provider-account link + its linked
 * financial_accounts row (which is `linked` and carries no ledger history). Never
 * touches a manual account, a movement, a bill, income, a transfer, or request 222.
 */
export async function removeLinkedSandboxAccount(userId: number, providerAccountId: number): Promise<{ removed: boolean }> {
  const rows = await db
    .select()
    .from(providerAccounts)
    .where(and(eq(providerAccounts.id, providerAccountId), eq(providerAccounts.userId, userId)));
  const pa = rows[0];
  if (!pa) return { removed: false };
  const linkedId = pa.financialAccountId;
  // Finance 1B.2 correction — safe teardown ORDER so a mapped provider account is
  // never left orphaning a linked Xanther account (and a manual account is never
  // touched):
  //   1. clear the mapping (the provider account becomes unmapped),
  //   2. delete the linked Xanther account ONLY if it is `linked` (never manual),
  //   3. delete the now-unmapped provider-account row.
  if (linkedId != null) {
    await db.update(providerAccounts).set({ financialAccountId: null, updatedAt: new Date() }).where(and(eq(providerAccounts.id, pa.id), eq(providerAccounts.userId, userId)));
    await db
      .delete(financialAccounts)
      .where(and(eq(financialAccounts.id, linkedId), eq(financialAccounts.userId, userId), eq(financialAccounts.balanceSource, "linked")));
  }
  await db.delete(providerAccounts).where(and(eq(providerAccounts.id, pa.id), eq(providerAccounts.userId, userId)));
  return { removed: true };
}

/** Map of financialAccountId → provider snapshot, for resolving linked balances. */
export async function linkedBalanceMap(userId: number): Promise<Map<number, LinkedSnapshot>> {
  const rows = await db
    .select()
    .from(providerAccounts)
    .where(and(eq(providerAccounts.userId, userId), isNull(providerAccounts.deletedAt)));
  const map = new Map<number, LinkedSnapshot>();
  for (const r of rows) {
    if (r.financialAccountId == null) continue;
    map.set(r.financialAccountId, {
      balanceCurrent: r.balanceCurrent,
      balanceAvailable: r.balanceAvailable,
      balanceAsOf: r.balanceAsOf,
      status: r.status,
      providerName: r.providerName,
      currencyCode: r.currencyCode,
    });
  }
  return map;
}
