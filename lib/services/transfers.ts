/* Transfers service — Finance 1A.2.
 *
 * Moves money between two OWNED accounts. A scheduled transfer changes no
 * balance. Completing a manual→manual transfer atomically deducts the source,
 * credits the destination, and writes paired transfer_out/transfer_in movements
 * (a single writable-CTE statement, guarded by status so a duplicate/concurrent
 * completion can't run twice). An internal transfer is never income or spending
 * and never changes total owned cash. Linked-account handling is intentionally
 * conservative (see completeTransfer). */

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { accountTransfers, financialAccounts } from "@/db/schema";
import { FinanceError, getAccount } from "@/lib/services/finances";
import type { TransferView } from "@/lib/types";

export type NewTransfer = typeof accountTransfers.$inferInsert;

const num = (v: string | null | undefined): number => (v ? parseFloat(v) : 0);

/* ------------------------------------------------------------- queries --- */

export async function getTransfer(userId: number, id: number) {
  const [row] = await db
    .select()
    .from(accountTransfers)
    .where(
      and(
        eq(accountTransfers.id, id),
        eq(accountTransfers.userId, userId),
        isNull(accountTransfers.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listTransfers(userId: number) {
  const fromAcct = alias(financialAccounts, "from_acct");
  const toAcct = alias(financialAccounts, "to_acct");
  return db
    .select({
      id: accountTransfers.id,
      fromAccountId: accountTransfers.fromAccountId,
      fromName: fromAcct.name,
      toAccountId: accountTransfers.toAccountId,
      toName: toAcct.name,
      amount: accountTransfers.amount,
      scheduledDate: accountTransfers.scheduledDate,
      status: accountTransfers.status,
      completedAt: accountTransfers.completedAt,
      note: accountTransfers.note,
    })
    .from(accountTransfers)
    .leftJoin(fromAcct, eq(accountTransfers.fromAccountId, fromAcct.id))
    .leftJoin(toAcct, eq(accountTransfers.toAccountId, toAcct.id))
    .where(and(eq(accountTransfers.userId, userId), isNull(accountTransfers.deletedAt)))
    .orderBy(desc(accountTransfers.scheduledDate), desc(accountTransfers.id));
}

export function toTransferViews(
  rows: Awaited<ReturnType<typeof listTransfers>>,
): TransferView[] {
  return rows.map((r) => ({
    id: r.id,
    fromAccountId: r.fromAccountId,
    fromName: r.fromName ?? null,
    toAccountId: r.toAccountId,
    toName: r.toName ?? null,
    amount: num(r.amount),
    scheduledDate: r.scheduledDate,
    status: r.status,
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    note: r.note,
  }));
}

/* ---------------------------------------------------------- validation --- */

/** An owned, live, active, non-credit account (transfers move cash, not debt). */
async function requireTransferAccount(userId: number, accountId: number, side: string) {
  const a = await getAccount(userId, accountId);
  if (!a) throw new FinanceError(400, `${side} account not found.`);
  if (a.active === false) throw new FinanceError(400, `${side} account is inactive.`);
  if (a.type === "credit")
    throw new FinanceError(400, "Credit accounts can't be used for cash transfers yet.");
  return a;
}

/* ------------------------------------------------------------- writes --- */

export async function createTransfer(
  userId: number,
  input: {
    fromAccountId: number;
    toAccountId: number;
    amount: number;
    scheduledDate?: string | null;
    note?: string | null;
  },
) {
  if (input.fromAccountId === input.toAccountId)
    throw new FinanceError(400, "Source and destination must be different accounts.");
  if (!(input.amount > 0)) throw new FinanceError(400, "Transfer amount must be positive.");
  await requireTransferAccount(userId, input.fromAccountId, "Source");
  await requireTransferAccount(userId, input.toAccountId, "Destination");

  const [row] = await db
    .insert(accountTransfers)
    .values({
      userId,
      fromAccountId: input.fromAccountId,
      toAccountId: input.toAccountId,
      amount: input.amount.toFixed(2),
      scheduledDate: input.scheduledDate ?? null,
      note: input.note ?? null,
      status: "scheduled",
    })
    .returning();
  return row;
}

/**
 * Complete a scheduled transfer.
 *
 * Only manual→manual completion is allowed in Finance 1A.2: atomically deduct
 * source, credit destination, write transfer_out + transfer_in movements, mark
 * completed (guarded by status='scheduled' so duplicate/concurrent completion is
 * a no-op). Any linked account involved (manual→linked, linked→manual,
 * linked→linked) is REJECTED — without bank-sync confirmation we will not deduct
 * one side while the other side is unconfirmed.
 *
 * Returns the completed transfer row, or null if it was not scheduled.
 */
export async function completeTransfer(userId: number, id: number) {
  const t = await getTransfer(userId, id);
  if (!t) return null;
  if (t.status !== "scheduled") return null;

  const from = await getAccount(userId, t.fromAccountId);
  const to = await getAccount(userId, t.toAccountId);
  if (!from || !to) throw new FinanceError(400, "A transfer account no longer exists.");
  if (from.balanceSource !== "manual" || to.balanceSource !== "manual")
    throw new FinanceError(
      400,
      "Transfers involving linked accounts require bank-sync confirmation and cannot be completed manually yet.",
    );

  const noteOut = `Transfer to ${to.name}`;
  const noteIn = `Transfer from ${from.name}`;

  // manual → manual: move both balances + paired movements, all-or-nothing.
  const res = await db.execute(sql`
    WITH done AS (
      UPDATE account_transfers SET status='completed', completed_at=now(), updated_at=now()
       WHERE id=${id} AND user_id=${userId} AND deleted_at IS NULL AND status='scheduled'
      RETURNING id, from_account_id, to_account_id, amount
    ),
    src AS (
      UPDATE financial_accounts
         SET current_balance = current_balance - (SELECT amount FROM done),
             balance_updated_at=now(), updated_at=now()
       WHERE id = (SELECT from_account_id FROM done) AND user_id=${userId}
         AND deleted_at IS NULL AND balance_source='manual' AND EXISTS (SELECT 1 FROM done)
      RETURNING id
    ),
    dst AS (
      UPDATE financial_accounts
         SET current_balance = current_balance + (SELECT amount FROM done),
             balance_updated_at=now(), updated_at=now()
       WHERE id = (SELECT to_account_id FROM done) AND user_id=${userId}
         AND deleted_at IS NULL AND balance_source='manual' AND EXISTS (SELECT 1 FROM done)
      RETURNING id
    ),
    mout AS (
      INSERT INTO account_movements
        (user_id, account_id, transfer_id, kind, amount, note, occurred_at, created_at)
      SELECT ${userId}, (SELECT from_account_id FROM done), ${id}, 'transfer_out',
             -(SELECT amount FROM done), ${noteOut}, now(), now()
       WHERE EXISTS (SELECT 1 FROM done) AND EXISTS (SELECT 1 FROM src) AND EXISTS (SELECT 1 FROM dst)
      RETURNING id
    ),
    min AS (
      INSERT INTO account_movements
        (user_id, account_id, transfer_id, kind, amount, note, occurred_at, created_at)
      SELECT ${userId}, (SELECT to_account_id FROM done), ${id}, 'transfer_in',
             (SELECT amount FROM done), ${noteIn}, now(), now()
       WHERE EXISTS (SELECT 1 FROM done) AND EXISTS (SELECT 1 FROM src) AND EXISTS (SELECT 1 FROM dst)
      RETURNING id
    )
    SELECT (SELECT id FROM done) AS tid, (SELECT id FROM mout) AS mout_id, (SELECT id FROM min) AS min_id
  `);
  const row = (res.rows ?? [])[0] as { tid: unknown } | undefined;
  if (!row || row.tid == null) return null;
  return getTransfer(userId, id);
}

/**
 * Reverse a completed transfer. Atomically undoes the balance change of every
 * un-reversed transfer movement and appends an equal-and-opposite reversal
 * movement pointing at the original (never deleted). Guarded by
 * status='completed' + the unique index on reversal_of_id → no double credit.
 */
export async function reverseTransfer(userId: number, id: number) {
  const t = await getTransfer(userId, id);
  if (!t) return null;
  if (t.status !== "completed") return null;
  const note = `Transfer reversed`;
  try {
    const res = await db.execute(sql`
      WITH reopened AS (
        UPDATE account_transfers SET status='reversed', updated_at=now()
         WHERE id=${id} AND user_id=${userId} AND deleted_at IS NULL AND status='completed'
        RETURNING id
      ),
      orig AS (
        SELECT m.id, m.account_id, m.amount, m.kind
          FROM account_movements m
         WHERE m.transfer_id=${id} AND m.user_id=${userId}
           AND m.kind IN ('transfer_out', 'transfer_in')
           AND NOT EXISTS (SELECT 1 FROM account_movements r WHERE r.reversal_of_id = m.id)
           AND EXISTS (SELECT 1 FROM reopened)
      ),
      upd AS (
        UPDATE financial_accounts fa
           SET current_balance = fa.current_balance + s.delta,
               balance_updated_at=now(), updated_at=now()
          FROM (SELECT account_id, sum(-amount) AS delta FROM orig GROUP BY account_id) s
         WHERE fa.id = s.account_id AND fa.user_id=${userId} AND fa.deleted_at IS NULL
           AND fa.balance_source='manual' AND EXISTS (SELECT 1 FROM orig)
        RETURNING fa.id
      ),
      rev AS (
        INSERT INTO account_movements
          (user_id, account_id, transfer_id, kind, amount, reversal_of_id, note, occurred_at, created_at)
        SELECT ${userId}, o.account_id, ${id}, (o.kind || '_reversal')::movement_kind,
               -o.amount, o.id, ${note}, now(), now()
          FROM orig o WHERE EXISTS (SELECT 1 FROM reopened)
        RETURNING id
      )
      SELECT (SELECT id FROM reopened) AS tid
    `);
    const row = (res.rows ?? [])[0] as { tid: unknown } | undefined;
    if (!row || row.tid == null) return null;
    return getTransfer(userId, id);
  } catch (err) {
    if (String(err).includes("account_movements_reversal_uq")) return null;
    throw err;
  }
}

/** Soft-delete a transfer. Only scheduled/cancelled/reversed ones — a completed
 * transfer must be reversed first so balances stay correct. */
export async function deleteTransfer(userId: number, id: number) {
  const t = await getTransfer(userId, id);
  if (!t) return null;
  if (t.status === "completed")
    throw new FinanceError(409, "Reverse this transfer before removing it.");
  const [row] = await db
    .update(accountTransfers)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(accountTransfers.id, id), eq(accountTransfers.userId, userId)))
    .returning();
  return row ?? null;
}
