/* POST /api/experience-requests/[id]/interpret — owner-triggered AI
 * interpretation of the request's natural-language text into structured
 * constraints. Enablement + cost gates and provider isolation live in the
 * orchestration service; this route only resolves ownership and maps errors. */

import { NextResponse } from "next/server";
import { getRequest } from "@/lib/services/experience-requests";
import { interpretRequest } from "@/lib/services/ai-experience";
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
      { error: "Add request text before interpreting." },
      { status: 400 },
    );
  }

  try {
    const out = await interpretRequest(CURRENT_USER_ID, request);
    return NextResponse.json(out);
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, category: err.category },
        { status: err.httpStatus },
      );
    }
    return NextResponse.json(
      { error: "Interpretation failed.", category: "db_failure" },
      { status: 500 },
    );
  }
}
