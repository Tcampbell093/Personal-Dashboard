/* /api/experiences/[id] — read; edit plan fields (only while `planned`);
 * soft-delete. Status changes are handled by ./resolve (one-way) and outcome
 * details by ./outcome — never here. */

import { NextResponse } from "next/server";
import {
  getExperience,
  updatePlannedExperience,
  deleteExperience,
  toExperienceView,
  ExperienceError,
  type PlanInput,
} from "@/lib/services/experiences";
import { PHYSICAL_DIFFICULTIES } from "@/lib/services/experience-requests";
import { CURRENT_USER_ID } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };
const parseId = (raw: string): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const isDate = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** undefined/null/"" -> null; valid approved value -> value; else INVALID. */
const ENUM_INVALID = Symbol("invalid");
function enumOrNull(
  v: unknown,
  allowed: readonly string[],
): string | null | typeof ENUM_INVALID {
  if (v === undefined || v === null || v === "") return null;
  return typeof v === "string" && allowed.includes(v) ? v : ENUM_INVALID;
}

export async function GET(_request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  try {
    const row = await getExperience(CURRENT_USER_ID, id);
    if (!row) return NextResponse.json({ error: "Experience not found." }, { status: 404 });
    return NextResponse.json({ experience: toExperienceView(row) });
  } catch (err) {
    return NextResponse.json({ error: "Could not load experience.", detail: String(err) }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) return NextResponse.json({ error: "Invalid id." }, { status: 400 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  const input: Partial<PlanInput> = {};

  if (typeof b.title === "string") {
    const t = b.title.trim();
    if (!t) return NextResponse.json({ error: "Title cannot be empty." }, { status: 400 });
    input.title = t;
  }
  if ("description" in b) input.description = typeof b.description === "string" ? b.description : null;
  if ("plannedDate" in b) {
    if (b.plannedDate && !isDate(b.plannedDate)) {
      return NextResponse.json({ error: "Invalid planned date." }, { status: 400 });
    }
    input.plannedDate = isDate(b.plannedDate) ? b.plannedDate : null;
  }
  if ("plannedTimeText" in b) input.plannedTimeText = typeof b.plannedTimeText === "string" && b.plannedTimeText ? b.plannedTimeText : null;
  if ("locationText" in b) input.locationText = typeof b.locationText === "string" && b.locationText ? b.locationText : null;
  if ("expectedCost" in b) {
    if (b.expectedCost === null || b.expectedCost === "") {
      input.expectedCost = null;
    } else {
      const n = Number(b.expectedCost);
      if (!Number.isFinite(n) || n < 0) return NextResponse.json({ error: "Expected cost must be a non-negative number." }, { status: 400 });
      input.expectedCost = n;
    }
  }
  if ("expectedDurationMinutes" in b) {
    if (b.expectedDurationMinutes === null || b.expectedDurationMinutes === "") {
      input.expectedDurationMinutes = null;
    } else {
      const n = Number(b.expectedDurationMinutes);
      if (!Number.isInteger(n) || n < 0) return NextResponse.json({ error: "Duration must be a non-negative integer." }, { status: 400 });
      input.expectedDurationMinutes = n;
    }
  }
  if ("physicalDifficulty" in b) {
    const v = enumOrNull(b.physicalDifficulty, PHYSICAL_DIFFICULTIES);
    if (v === ENUM_INVALID) {
      return NextResponse.json({ error: "Invalid physical difficulty." }, { status: 400 });
    }
    input.physicalDifficulty = v as never;
  }
  if ("desiredFeeling" in b) input.desiredFeeling = typeof b.desiredFeeling === "string" && b.desiredFeeling ? b.desiredFeeling : null;
  if ("notes" in b) input.notes = typeof b.notes === "string" && b.notes ? b.notes : null;

  try {
    const row = await updatePlannedExperience(CURRENT_USER_ID, id, input);
    return NextResponse.json({ experience: toExperienceView(row) });
  } catch (err) {
    if (err instanceof ExperienceError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    return NextResponse.json({ error: "Could not update experience.", detail: String(err) }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  try {
    await deleteExperience(CURRENT_USER_ID, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ExperienceError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    return NextResponse.json({ error: "Could not delete experience.", detail: String(err) }, { status: 500 });
  }
}
