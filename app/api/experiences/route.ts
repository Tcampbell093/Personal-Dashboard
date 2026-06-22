/* /api/experiences — list planned + resolved history + XP summary; create a
 * planned experience from an owned request (duplicate-safe). */

import { NextResponse } from "next/server";
import {
  listPlanned,
  listHistory,
  xpSummary,
  createPlannedExperience,
  toExperienceView,
  toExperienceViews,
  ExperienceError,
  type PlanInput,
} from "@/lib/services/experiences";
import { PHYSICAL_DIFFICULTIES } from "@/lib/services/experience-requests";
import { CURRENT_USER_ID } from "@/lib/auth";

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

export async function GET() {
  try {
    const [planned, history, xp] = await Promise.all([
      listPlanned(CURRENT_USER_ID),
      listHistory(CURRENT_USER_ID),
      xpSummary(CURRENT_USER_ID),
    ]);
    return NextResponse.json({
      planned: toExperienceViews(planned),
      history: toExperienceViews(history),
      xp,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not load experiences.", detail: String(err) },
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

  const requestId = Number(b.requestId);
  if (!Number.isInteger(requestId) || requestId <= 0) {
    return NextResponse.json({ error: "A valid requestId is required." }, { status: 400 });
  }
  const title = typeof b.title === "string" ? b.title.trim() : "";
  if (!title) {
    return NextResponse.json({ error: "Title is required." }, { status: 400 });
  }
  if (b.plannedDate !== undefined && b.plannedDate !== null && b.plannedDate !== "" && !isDate(b.plannedDate)) {
    return NextResponse.json({ error: "Invalid planned date." }, { status: 400 });
  }
  let expectedCost: number | null = null;
  if (b.expectedCost !== undefined && b.expectedCost !== null && b.expectedCost !== "") {
    const n = Number(b.expectedCost);
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json({ error: "Expected cost must be a non-negative number." }, { status: 400 });
    }
    expectedCost = n;
  }
  let expectedDurationMinutes: number | null = null;
  if (b.expectedDurationMinutes !== undefined && b.expectedDurationMinutes !== null && b.expectedDurationMinutes !== "") {
    const n = Number(b.expectedDurationMinutes);
    if (!Number.isInteger(n) || n < 0) {
      return NextResponse.json({ error: "Duration must be a non-negative integer." }, { status: 400 });
    }
    expectedDurationMinutes = n;
  }
  const physicalDifficulty = enumOrNull(b.physicalDifficulty, PHYSICAL_DIFFICULTIES);
  if (physicalDifficulty === ENUM_INVALID) {
    return NextResponse.json({ error: "Invalid physical difficulty." }, { status: 400 });
  }

  const input: PlanInput = {
    title,
    description: typeof b.description === "string" ? b.description : null,
    plannedDate: isDate(b.plannedDate) ? b.plannedDate : null,
    plannedTimeText: typeof b.plannedTimeText === "string" && b.plannedTimeText ? b.plannedTimeText : null,
    locationText: typeof b.locationText === "string" && b.locationText ? b.locationText : null,
    expectedCost,
    expectedDurationMinutes,
    physicalDifficulty: physicalDifficulty as never,
    desiredFeeling: typeof b.desiredFeeling === "string" && b.desiredFeeling ? b.desiredFeeling : null,
    notes: typeof b.notes === "string" && b.notes ? b.notes : null,
  };

  try {
    const row = await createPlannedExperience(CURRENT_USER_ID, requestId, input);
    return NextResponse.json({ experience: toExperienceView(row) }, { status: 201 });
  } catch (err) {
    if (err instanceof ExperienceError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    return NextResponse.json(
      { error: "Could not create planned experience.", detail: String(err) },
      { status: 500 },
    );
  }
}
