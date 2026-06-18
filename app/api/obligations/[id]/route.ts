/* /api/obligations/[id] — update, complete (status=done), and soft-delete.
 * Mirrors /api/tasks/[id]. */

import { NextResponse } from "next/server";
import {
  updateObligation,
  deleteObligation,
  OBLIGATION_TYPES,
  IMPORTANCE,
  OBLIGATION_STATUSES as STATUSES,
  type NewObligation,
} from "@/lib/services/obligations";
import { CURRENT_USER_ID } from "@/lib/auth";

const isDate = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

type Ctx = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function PATCH(request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json({ error: "Invalid obligation id." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  const patch: Partial<NewObligation> = {};

  if (typeof b.title === "string") {
    const title = b.title.trim();
    if (!title) {
      return NextResponse.json({ error: "Title cannot be empty." }, { status: 400 });
    }
    patch.title = title;
  }
  if ("startDate" in b) {
    if (!isDate(b.startDate)) {
      return NextResponse.json({ error: "Invalid start date." }, { status: 400 });
    }
    patch.startDate = b.startDate;
  }
  if ("startTime" in b) {
    patch.startTime =
      typeof b.startTime === "string" && b.startTime ? b.startTime : null;
  }
  if ("location" in b) {
    patch.location = typeof b.location === "string" && b.location ? b.location : null;
  }
  if (b.type !== undefined) {
    if (!OBLIGATION_TYPES.includes(b.type as never)) {
      return NextResponse.json({ error: "Invalid type." }, { status: 400 });
    }
    patch.type = b.type as (typeof OBLIGATION_TYPES)[number];
  }
  if (b.importance !== undefined) {
    if (!IMPORTANCE.includes(b.importance as never)) {
      return NextResponse.json({ error: "Invalid importance." }, { status: 400 });
    }
    patch.importance = b.importance as (typeof IMPORTANCE)[number];
  }
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status as never)) {
      return NextResponse.json({ error: "Invalid status." }, { status: 400 });
    }
    patch.status = b.status as (typeof STATUSES)[number];
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  try {
    const row = await updateObligation(CURRENT_USER_ID, id, patch);
    if (!row) {
      return NextResponse.json({ error: "Obligation not found." }, { status: 404 });
    }
    return NextResponse.json({ obligation: row });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not update obligation.", detail: String(err) },
      { status: 500 },
    );
  }
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json({ error: "Invalid obligation id." }, { status: 400 });
  }

  try {
    const row = await deleteObligation(CURRENT_USER_ID, id);
    if (!row) {
      return NextResponse.json({ error: "Obligation not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not delete obligation.", detail: String(err) },
      { status: 500 },
    );
  }
}
