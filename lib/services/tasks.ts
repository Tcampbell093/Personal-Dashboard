/* Tasks service — the reference implementation for the service layer.
 * All DB access for tasks goes through here. Route handlers and the scheduled
 * function call these functions; UI components never touch the database.
 * Other entities (obligations, signals, etc.) should mirror this shape. */

import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import type { TaskView } from "@/lib/types";

export type NewTask = typeof tasks.$inferInsert;
export type TaskRow = typeof tasks.$inferSelect;

/* Map DB rows -> the UI view model (TaskView). Keeps the dashboard decoupled
 * from the Drizzle row shape. The Neon HTTP driver returns `date` columns as
 * "YYYY-MM-DD" strings and `time` columns as "HH:MM:SS"; the UI wants "HH:MM",
 * so we trim the seconds. */
export function toTaskViews(rows: TaskRow[]): TaskView[] {
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    dueDate: r.dueDate,
    dueTime: r.dueTime ? r.dueTime.slice(0, 5) : null,
    priority: r.priority,
    status: r.status,
    category: r.category,
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
  }));
}

/** List live (non-soft-deleted) tasks for a user. */
export async function listTasks(userId: number): Promise<TaskRow[]> {
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, userId), isNull(tasks.deletedAt)))
    .orderBy(desc(tasks.createdAt));
}

export async function createTask(input: NewTask): Promise<TaskRow> {
  const [row] = await db.insert(tasks).values(input).returning();
  return row;
}

export async function updateTask(
  userId: number,
  id: number,
  patch: Partial<NewTask>,
): Promise<TaskRow | null> {
  const [row] = await db
    .update(tasks)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(tasks.id, id), eq(tasks.userId, userId), isNull(tasks.deletedAt)))
    .returning();
  return row ?? null;
}

export async function completeTask(userId: number, id: number) {
  return updateTask(userId, id, {
    status: "completed",
    completedAt: new Date(),
  });
}

/** Reopen a completed task: return it to the active list and clear the
 * completion timestamp. Never hard-deletes; the row is the same task. */
export async function reopenTask(userId: number, id: number) {
  return updateTask(userId, id, {
    status: "not_started",
    completedAt: null,
  } as Partial<NewTask>);
}

export async function deferTask(userId: number, id: number) {
  return updateTask(userId, id, { status: "deferred" });
}

/** Soft delete — never a hard delete in Phase 1. */
export async function deleteTask(userId: number, id: number) {
  return updateTask(userId, id, { deletedAt: new Date() } as Partial<NewTask>);
}
