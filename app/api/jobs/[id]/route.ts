/* /api/jobs/[id] — update (incl. dismiss) + soft-delete. */

import { NextResponse } from "next/server";
import {
  updateJob,
  deleteJob,
  JOB_STATUSES,
  WORK_ARRANGEMENTS,
  type NewJob,
} from "@/lib/services/jobs";
import { CURRENT_USER_ID } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };
const parseId = (raw: string): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export async function PATCH(request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json({ error: "Invalid job id." }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  const patch: Partial<NewJob> = {};

  if (typeof b.title === "string") {
    const title = b.title.trim();
    if (!title) {
      return NextResponse.json({ error: "Title cannot be empty." }, { status: 400 });
    }
    patch.title = title;
  }
  if ("company" in b) {
    patch.company = typeof b.company === "string" && b.company ? b.company : null;
  }
  if ("location" in b) {
    patch.location = typeof b.location === "string" && b.location ? b.location : null;
  }
  if (b.workArrangement !== undefined) {
    if (!WORK_ARRANGEMENTS.includes(b.workArrangement as never)) {
      return NextResponse.json({ error: "Invalid work arrangement." }, { status: 400 });
    }
    patch.workArrangement = b.workArrangement as (typeof WORK_ARRANGEMENTS)[number];
  }
  if (b.status !== undefined) {
    if (!JOB_STATUSES.includes(b.status as never)) {
      return NextResponse.json({ error: "Invalid status." }, { status: 400 });
    }
    patch.status = b.status as (typeof JOB_STATUSES)[number];
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  try {
    const row = await updateJob(CURRENT_USER_ID, id, patch);
    if (!row) {
      return NextResponse.json({ error: "Job not found." }, { status: 404 });
    }
    return NextResponse.json({ job: row });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not update job.", detail: String(err) },
      { status: 500 },
    );
  }
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json({ error: "Invalid job id." }, { status: 400 });
  }
  try {
    const row = await deleteJob(CURRENT_USER_ID, id);
    if (!row) {
      return NextResponse.json({ error: "Job not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not delete job.", detail: String(err) },
      { status: 500 },
    );
  }
}
