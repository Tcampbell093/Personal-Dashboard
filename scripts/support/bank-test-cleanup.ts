/* Shared exact-ID cleanup for the bank-finance verification harnesses
 * (Finance 1B.3A.1). Used by verify-finance1b1/1b2/1b3a so a passing, failing, OR
 * interrupted run always removes its OWN temporary records — never an owner
 * record — in safe foreign-key dependency order:
 *   1. imported transactions  → 2. clear provider mappings → 3. linked accounts
 *   → 4. provider accounts     → 5. financial connections.
 *
 * It is idempotent (existence-checked) and exact-ID (operates only on the ids the
 * harness registered, plus a provably-test startup sweep). The earlier leak was a
 * raw `DELETE financial_accounts` that FK-violated (a provider account still
 * referenced it) and was swallowed; here the mapping is always cleared first. */

import { and, eq, inArray, isNull, like } from "drizzle-orm";
import { db } from "@/db";
import { financialAccounts, financialConnections, importedTransactions, providerAccounts } from "@/db/schema";
import { deleteConnection } from "@/lib/services/connections";
import { listProviderAccounts, removeLinkedSandboxAccount } from "@/lib/services/provider-accounts";

export interface BankTestRecords {
  connIds: number[]; // temporary financial_connections
  acctIds: number[]; // temporary linked financial_accounts
}
export const newRecords = (): BankTestRecords => ({ connIds: [], acctIds: [] });

// Real owner accounts that must NEVER be treated as test data.
export const REAL_ACCOUNT_NAMES = ["Chase", "BofA", "Plaid Checking"];

/**
 * Tear down all registered temporary records in safe FK order. Idempotent and
 * exact-ID — only touches the connIds/acctIds passed in. Never throws.
 */
export async function cleanupBankTestRecords(userId: number, r: BankTestRecords): Promise<void> {
  // 1. imported transactions for the temp connections (explicit; also cascade-covered).
  if (r.connIds.length) {
    await db.delete(importedTransactions).where(and(eq(importedTransactions.userId, userId), inArray(importedTransactions.connectionId, r.connIds))).catch(() => {});
  }
  // 2+3+4. per temp connection: removeLinkedSandboxAccount clears the mapping, then
  // deletes the linked (`linked`-only) account, then the provider-account row.
  for (const cid of r.connIds) {
    const pas = await listProviderAccounts(userId, cid).catch(() => [] as { id: number }[]);
    for (const p of pas) await removeLinkedSandboxAccount(userId, p.id).catch(() => {});
  }
  // Any registered temp linked account not yet removed → unmap (defensive) then
  // delete BY EXACT ID, guarded to `linked` so a manual account is never touched.
  for (const id of r.acctIds) {
    const rows = await db.select().from(financialAccounts).where(and(eq(financialAccounts.id, id), eq(financialAccounts.userId, userId), eq(financialAccounts.balanceSource, "linked")));
    if (!rows.length) continue;
    await db.update(providerAccounts).set({ financialAccountId: null }).where(eq(providerAccounts.financialAccountId, id)).catch(() => {});
    await db.delete(financialAccounts).where(and(eq(financialAccounts.id, id), eq(financialAccounts.userId, userId), eq(financialAccounts.balanceSource, "linked"))).catch(() => {});
  }
  // 5. temp connections (cascade removes any remaining imported txns + unmapped provider accounts).
  for (const cid of r.connIds) await deleteConnection(userId, cid).catch(() => {});
}

/**
 * Startup sweep: detect clearly-identifiable stale TEST accounts (a unique test
 * name prefix) left by a prior interrupted run, and remove them by exact ID. It
 * REFUSES to run (throws) if any prefix-matched row is a real owner account, and
 * never deletes an ambiguous (non-prefixed) record. Returns what it found/cleaned.
 */
export async function sweepStaleTestAccounts(userId: number, prefix: string): Promise<{ found: string[]; cleaned: number }> {
  const stale = await db.select().from(financialAccounts).where(and(eq(financialAccounts.userId, userId), like(financialAccounts.name, `${prefix}%`)));
  const found = stale.map((a) => a.name);
  if (stale.some((a) => REAL_ACCOUNT_NAMES.includes(a.name))) {
    throw new Error(`Refusing to sweep: a real owner account matched the test prefix '${prefix}'.`);
  }
  for (const a of stale) {
    await db.update(providerAccounts).set({ financialAccountId: null }).where(eq(providerAccounts.financialAccountId, a.id)).catch(() => {});
    await db.delete(importedTransactions).where(eq(importedTransactions.financialAccountId, a.id)).catch(() => {});
    await db.delete(financialAccounts).where(and(eq(financialAccounts.id, a.id), eq(financialAccounts.userId, userId), eq(financialAccounts.balanceSource, "linked"))).catch(() => {});
  }
  return { found, cleaned: stale.length };
}

/** Count active linked accounts that do NOT have exactly one active provider mapping. */
export async function orphanLinkedCount(userId: number): Promise<number> {
  const linked = await db.select().from(financialAccounts).where(and(eq(financialAccounts.userId, userId), eq(financialAccounts.balanceSource, "linked"), isNull(financialAccounts.deletedAt)));
  let orphan = 0;
  for (const l of linked) {
    const m = await db.select().from(providerAccounts).where(and(eq(providerAccounts.financialAccountId, l.id), isNull(providerAccounts.deletedAt)));
    if (m.length !== 1) orphan++;
  }
  return orphan;
}
