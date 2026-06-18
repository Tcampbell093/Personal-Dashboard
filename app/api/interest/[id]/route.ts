/* /api/interest/[id] — update (incl. dismiss) + soft-delete. */

import { NextResponse } from "next/server";
import {
  updateInterestItem,
  deleteInterestItem,
  INTEREST_STATUSES,
  type NewInterestItem,
} from "@/lib/services/interest";
import { CURRENT_USER_ID } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };
const parseId = (raw: string): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export async function PATCH(request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json({ error: "Invalid interest id." }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  const patch: Partial<NewInterestItem> = {};

  if (typeof b.title === "string") {
    const title = b.title.trim();
    if (!title) {
      return NextResponse.json({ error: "Title cannot be empty." }, { status: 400 });
    }
    patch.title = title;
  }
  if ("source" in b) {
    patch.source = typeof b.source === "string" && b.source ? b.source : null;
  }
  if (b.status !== undefined) {
    if (!INTEREST_STATUSES.includes(b.status as never)) {
      return NextResponse.json({ error: "Invalid status." }, { status: 400 });
    }
    patch.status = b.status as (typeof INTEREST_STATUSES)[number];
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  try {
    const row = await updateInterestItem(CURRENT_USER_ID, id, patch);
    if (!row) {
      return NextResponse.json({ error: "Interest item not found." }, { status: 404 });
    }
    return NextResponse.json({ interest: row });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not update interest item.", detail: String(err) },
      { status: 500 },
    );
  }
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json({ error: "Invalid interest id." }, { status: 400 });
  }
  try {
    const row = await deleteInterestItem(CURRENT_USER_ID, id);
    if (!row) {
      return NextResponse.json({ error: "Interest item not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not delete interest item.", detail: String(err) },
      { status: 500 },
    );
  }
}
