/* /api/tasks route handler — template for the API layer.
 * On Netlify, App Router route handlers are deployed as serverless Functions,
 * so this is your "Netlify Function" for task writes without a separate file.
 *
 * Validation is intentionally explicit (no schema library yet) to keep the
 * dependency list small. Swap in zod later if validation grows.
 *
 * NOTE: user identity is resolved server-side. The client never sends userId. */

import { NextResponse } from "next/server";
import { createTask, listTasks } from "@/lib/services/tasks";
import { CURRENT_USER_ID } from "@/lib/auth";

const PRIORITIES = ["low", "medium", "high", "critical"] as const;
const STATUSES = [
  "not_started",
  "in_progress",
  "completed",
  "deferred",
  "cancelled",
] as const;

export async function GET() {
  try {
    const rows = await listTasks(CURRENT_USER_ID);
    return NextResponse.json({ tasks: rows });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not load tasks.", detail: String(err) },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  const title = typeof b.title === "string" ? b.title.trim() : "";
  if (!title) {
    return NextResponse.json({ error: "Title is required." }, { status: 400 });
  }

  const priority = PRIORITIES.includes(b.priority as never)
    ? (b.priority as (typeof PRIORITIES)[number])
    : "medium";
  const status = STATUSES.includes(b.status as never)
    ? (b.status as (typeof STATUSES)[number])
    : "not_started";

  try {
    const row = await createTask({
      userId: CURRENT_USER_ID,
      title,
      description: typeof b.description === "string" ? b.description : null,
      dueDate: typeof b.dueDate === "string" ? b.dueDate : null,
      priority,
      status,
      category: typeof b.category === "string" ? b.category : null,
      notes: typeof b.notes === "string" ? b.notes : null,
    });
    return NextResponse.json({ task: row }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not create task.", detail: String(err) },
      { status: 500 },
    );
  }
}
