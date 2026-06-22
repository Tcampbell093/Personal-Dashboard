/* /api/experiences/[id]/resolve — one-way resolution of a planned experience to
 * completed / cancelled / not_completed. XP is computed server-side. Any
 * client-supplied XP or userId is ignored. */

import { NextResponse } from "next/server";
import {
  resolveExperience,
  RESOLVED_STATUSES,
  ExperienceError,
  toExperienceView,
  type OutcomeInput,
  type ResolvedStatus,
} from "@/lib/services/experiences";
import { CURRENT_USER_ID } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };
const parseId = (raw: string): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Parse + validate the optional outcome detail fields. Returns the input or a
 * NextResponse error. */
function parseOutcome(b: Record<string, unknown>): OutcomeInput | NextResponse {
  const input: OutcomeInput = {};
  if ("actualCost" in b) {
    if (b.actualCost === null || b.actualCost === "") {
      input.actualCost = null;
    } else {
      const n = Number(b.actualCost);
      if (!Number.isFinite(n) || n < 0) {
        return NextResponse.json({ error: "Actual cost must be a non-negative number." }, { status: 400 });
      }
      input.actualCost = n;
    }
  }
  if ("rating" in b) {
    if (b.rating === null || b.rating === "") {
      input.rating = null;
    } else {
      const n = Number(b.rating);
      if (!Number.isInteger(n) || n < 1 || n > 5) {
        return NextResponse.json({ error: "Rating must be an integer from 1 to 5." }, { status: 400 });
      }
      input.rating = n;
    }
  }
  if ("reflection" in b) input.reflection = typeof b.reflection === "string" ? b.reflection : null;
  if ("nonCompletionReason" in b)
    input.nonCompletionReason = typeof b.nonCompletionReason === "string" ? b.nonCompletionReason : null;
  if ("meaningfulExperience" in b) {
    if (typeof b.meaningfulExperience !== "boolean") {
      return NextResponse.json({ error: "meaningfulExperience must be a boolean." }, { status: 400 });
    }
    input.meaningfulExperience = b.meaningfulExperience;
  }
  return input;
}

export async function POST(request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) return NextResponse.json({ error: "Invalid id." }, { status: 400 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  if (!RESOLVED_STATUSES.includes(b.status as never)) {
    return NextResponse.json(
      { error: "status must be completed, cancelled, or not_completed." },
      { status: 400 },
    );
  }
  const status = b.status as ResolvedStatus;

  const parsed = parseOutcome(b);
  if (parsed instanceof NextResponse) return parsed;

  try {
    const row = await resolveExperience(CURRENT_USER_ID, id, status, parsed);
    return NextResponse.json({ experience: toExperienceView(row) });
  } catch (err) {
    if (err instanceof ExperienceError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    return NextResponse.json({ error: "Could not resolve experience.", detail: String(err) }, { status: 500 });
  }
}
