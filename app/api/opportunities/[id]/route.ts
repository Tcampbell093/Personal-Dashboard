/* /api/opportunities/[id] — update (incl. dismiss) + soft-delete. */

import { NextResponse } from "next/server";
import {
  updateOpportunity,
  deleteOpportunity,
  OPPORTUNITY_CATEGORIES,
  OPPORTUNITY_STATUSES,
  RISK_LEVELS,
  type NewOpportunity,
} from "@/lib/services/opportunities";
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
    return NextResponse.json({ error: "Invalid opportunity id." }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  const patch: Partial<NewOpportunity> = {};

  if (typeof b.title === "string") {
    const title = b.title.trim();
    if (!title) {
      return NextResponse.json({ error: "Title cannot be empty." }, { status: 400 });
    }
    patch.title = title;
  }
  if ("summary" in b) {
    patch.summary = typeof b.summary === "string" && b.summary ? b.summary : null;
  }
  if ("timeWindowEnd" in b) {
    if (b.timeWindowEnd && !isDate(b.timeWindowEnd)) {
      return NextResponse.json({ error: "Invalid time window." }, { status: 400 });
    }
    patch.timeWindowEnd = isDate(b.timeWindowEnd) ? b.timeWindowEnd : null;
  }
  if (b.potentialValue !== undefined) {
    const v = Number(b.potentialValue);
    if (!Number.isFinite(v) || v < 0) {
      return NextResponse.json({ error: "Invalid potential value." }, { status: 400 });
    }
    patch.potentialValue = String(v);
  }
  if (b.category !== undefined) {
    if (!OPPORTUNITY_CATEGORIES.includes(b.category as never)) {
      return NextResponse.json({ error: "Invalid category." }, { status: 400 });
    }
    patch.category = b.category as (typeof OPPORTUNITY_CATEGORIES)[number];
  }
  if (b.estimatedRisk !== undefined) {
    if (!RISK_LEVELS.includes(b.estimatedRisk as never)) {
      return NextResponse.json({ error: "Invalid risk level." }, { status: 400 });
    }
    patch.estimatedRisk = b.estimatedRisk as (typeof RISK_LEVELS)[number];
  }
  if (b.status !== undefined) {
    if (!OPPORTUNITY_STATUSES.includes(b.status as never)) {
      return NextResponse.json({ error: "Invalid status." }, { status: 400 });
    }
    patch.status = b.status as (typeof OPPORTUNITY_STATUSES)[number];
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  try {
    const row = await updateOpportunity(CURRENT_USER_ID, id, patch);
    if (!row) {
      return NextResponse.json({ error: "Opportunity not found." }, { status: 404 });
    }
    return NextResponse.json({ opportunity: row });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not update opportunity.", detail: String(err) },
      { status: 500 },
    );
  }
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json({ error: "Invalid opportunity id." }, { status: 400 });
  }
  try {
    const row = await deleteOpportunity(CURRENT_USER_ID, id);
    if (!row) {
      return NextResponse.json({ error: "Opportunity not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not delete opportunity.", detail: String(err) },
      { status: 500 },
    );
  }
}
