/* /api/signals/[id] — update (incl. dismiss) + soft-delete. */

import { NextResponse } from "next/server";
import {
  updateSignal,
  deleteSignal,
  SIGNAL_TYPES,
  SIGNAL_STATUSES,
  type NewSignal,
} from "@/lib/services/signals";
import { CURRENT_USER_ID } from "@/lib/auth";

const isDate = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

type Ctx = { params: Promise<{ id: string }> };
const parseId = (raw: string): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export async function PATCH(request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json({ error: "Invalid signal id." }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  const patch: Partial<NewSignal> = {};

  if (typeof b.title === "string") {
    const title = b.title.trim();
    if (!title) {
      return NextResponse.json({ error: "Title cannot be empty." }, { status: 400 });
    }
    patch.title = title;
  }
  if ("location" in b) {
    patch.location = typeof b.location === "string" && b.location ? b.location : null;
  }
  if ("eventDate" in b) {
    if (b.eventDate && !isDate(b.eventDate)) {
      return NextResponse.json({ error: "Invalid event date." }, { status: 400 });
    }
    patch.eventDate = isDate(b.eventDate) ? b.eventDate : null;
  }
  if (b.type !== undefined) {
    if (!SIGNAL_TYPES.includes(b.type as never)) {
      return NextResponse.json({ error: "Invalid type." }, { status: 400 });
    }
    patch.type = b.type as (typeof SIGNAL_TYPES)[number];
  }
  if (b.status !== undefined) {
    if (!SIGNAL_STATUSES.includes(b.status as never)) {
      return NextResponse.json({ error: "Invalid status." }, { status: 400 });
    }
    patch.status = b.status as (typeof SIGNAL_STATUSES)[number];
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  try {
    const row = await updateSignal(CURRENT_USER_ID, id, patch);
    if (!row) {
      return NextResponse.json({ error: "Signal not found." }, { status: 404 });
    }
    return NextResponse.json({ signal: row });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not update signal.", detail: String(err) },
      { status: 500 },
    );
  }
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json({ error: "Invalid signal id." }, { status: 400 });
  }
  try {
    const row = await deleteSignal(CURRENT_USER_ID, id);
    if (!row) {
      return NextResponse.json({ error: "Signal not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not delete signal.", detail: String(err) },
      { status: 500 },
    );
  }
}
