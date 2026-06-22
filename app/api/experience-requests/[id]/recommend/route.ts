/* POST /api/experience-requests/[id]/recommend — owner-triggered AI generation
 * (or regeneration) of exactly three experience recommendation concepts. Gates,
 * cost enforcement, validation, and provider isolation live in the orchestration
 * service; this route resolves ownership/state and maps errors. */

import { NextResponse } from "next/server";
import {
  getRequest,
  RECOMMENDABLE_STATUSES,
} from "@/lib/services/experience-requests";
import { generateRecommendations } from "@/lib/services/ai-experience";
import { AiError } from "@/lib/ai/provider";
import { CURRENT_USER_ID } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };
const parseId = (raw: string): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export async function POST(_request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  }

  let request;
  try {
    request = await getRequest(CURRENT_USER_ID, id);
  } catch (err) {
    return NextResponse.json(
      { error: "Could not load request.", category: "db_failure", detail: String(err) },
      { status: 500 },
    );
  }
  if (!request) {
    return NextResponse.json({ error: "Request not found." }, { status: 404 });
  }
  if (!request.requestText?.trim()) {
    return NextResponse.json(
      { error: "Add request text before finding experiences." },
      { status: 400 },
    );
  }
  if (!(RECOMMENDABLE_STATUSES as readonly string[]).includes(request.status)) {
    // Only `planned` is excluded today — a live plan exists for this request.
    return NextResponse.json(
      { error: "A plan already exists for this request.", category: "conflict" },
      { status: 409 },
    );
  }

  try {
    const out = await generateRecommendations(CURRENT_USER_ID, request);
    return NextResponse.json(out);
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, category: err.category },
        { status: err.httpStatus },
      );
    }
    return NextResponse.json(
      { error: "Recommendation generation failed.", category: "db_failure" },
      { status: 500 },
    );
  }
}
