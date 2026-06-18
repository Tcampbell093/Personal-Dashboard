/* /api/tasks/[id] — update, complete, and (soft) delete a single task.
 * Mirrors the validation style of ../route.ts: explicit checks, no schema lib.
 *
 * PATCH  body may include: title, description, dueDate, priority, status,
 *        category, notes. Only provided keys are changed. Sending
 *        { status: "completed" } marks it done (completedAt is set by the
 *        service via completeTask). Everything is scoped to the current user.
 * DELETE performs a soft delete (sets deletedAt); rows are never hard-deleted. */

import { NextResponse } from "next/server";
import {
  updateTask,
  completeTask,
  deleteTask,
  type NewTask,
} from "@/lib/services/tasks";
import { CURRENT_USER_ID } from "@/lib/auth";

const PRIORITIES = ["low", "medium", "high", "critical"] as const;
const STATUSES = [
  "not_started",
  "in_progress",
  "completed",
  "deferred",
  "cancelled",
] as const;

// In Next.js 15 route handlers, the dynamic-segment params arrive as a Promise.
type Ctx = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function PATCH(request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json({ error: "Invalid task id." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  // Build a patch from only the keys that were actually provided.
  const patch: Partial<NewTask> = {};

  if (typeof b.title === "string") {
    const title = b.title.trim();
    if (!title) {
      return NextResponse.json({ error: "Title cannot be empty." }, { status: 400 });
    }
    patch.title = title;
  }
  if ("description" in b) {
    patch.description = typeof b.description === "string" ? b.description : null;
  }
  if ("dueDate" in b) {
    patch.dueDate = typeof b.dueDate === "string" && b.dueDate ? b.dueDate : null;
  }
  if ("category" in b) {
    patch.category = typeof b.category === "string" ? b.category : null;
  }
  if ("notes" in b) {
    patch.notes = typeof b.notes === "string" ? b.notes : null;
  }
  if (b.priority !== undefined) {
    if (!PRIORITIES.includes(b.priority as never)) {
      return NextResponse.json({ error: "Invalid priority." }, { status: 400 });
    }
    patch.priority = b.priority as (typeof PRIORITIES)[number];
  }
  if (b.status !== undefined && !STATUSES.includes(b.status as never)) {
    return NextResponse.json({ error: "Invalid status." }, { status: 400 });
  }

  try {
    // "completed" goes through completeTask so completedAt is stamped.
    let row;
    if (b.status === "completed") {
      row = await completeTask(CURRENT_USER_ID, id);
      if (Object.keys(patch).length > 0) {
        row = await updateTask(CURRENT_USER_ID, id, patch);
      }
    } else {
      if (b.status !== undefined) {
        patch.status = b.status as (typeof STATUSES)[number];
      }
      if (Object.keys(patch).length === 0) {
        return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
      }
      row = await updateTask(CURRENT_USER_ID, id, patch);
    }

    if (!row) {
      return NextResponse.json({ error: "Task not found." }, { status: 404 });
    }
    return NextResponse.json({ task: row });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not update task.", detail: String(err) },
      { status: 500 },
    );
  }
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json({ error: "Invalid task id." }, { status: 400 });
  }

  try {
    const row = await deleteTask(CURRENT_USER_ID, id);
    if (!row) {
      return NextResponse.json({ error: "Task not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not delete task.", detail: String(err) },
      { status: 500 },
    );
  }
}
