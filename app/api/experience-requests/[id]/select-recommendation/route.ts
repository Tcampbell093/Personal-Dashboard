/* POST /api/experience-requests/[id]/select-recommendation — Build 2B.2.
 * The owner chooses one stored recommendation; the server creates exactly one
 * planned experience from the request's CURRENT stored batch in a single atomic
 * statement. The body must contain ONLY { recommendationId }: no title/cost/
 * description/location/duration/object/ownership fields are accepted — every
 * authoritative value is resolved server-side. */

import { NextResponse } from "next/server";
import { selectRecommendation } from "@/lib/services/experiences";
import { ExperienceError } from "@/lib/services/experiences";
import { toExperienceView } from "@/lib/services/experiences";
import { CURRENT_USER_ID } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };
const parseId = (raw: string): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export async function POST(request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }

  // Strict body: exactly one key, `recommendationId`. Reject extras (e.g. a client
  // trying to smuggle title/cost/location or a full recommendation object) with 422.
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 422 });
  }
  const keys = Object.keys(body as Record<string, unknown>);
  const extras = keys.filter((k) => k !== "recommendationId");
  if (extras.length > 0) {
    return NextResponse.json(
      { error: `Unexpected field(s): ${extras.join(", ")}. Only recommendationId is accepted.` },
      { status: 422 },
    );
  }
  const recommendationId = (body as Record<string, unknown>).recommendationId;
  if (typeof recommendationId !== "string" || !/^rec_[A-Za-z0-9-]{1,60}$/.test(recommendationId)) {
    return NextResponse.json(
      { error: "recommendationId must be a valid recommendation id." },
      { status: 422 },
    );
  }

  try {
    const row = await selectRecommendation(CURRENT_USER_ID, id, recommendationId);
    return NextResponse.json({ experience: toExperienceView(row) });
  } catch (err) {
    if (err instanceof ExperienceError) {
      // Bounded message only — never expose database internals.
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    return NextResponse.json({ error: "Could not create the plan." }, { status: 500 });
  }
}
