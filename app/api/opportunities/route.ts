/* /api/opportunities — list + create (manual "Create Opportunity" flow). */

import { NextResponse } from "next/server";
import {
  createOpportunity,
  listOpportunities,
  OPPORTUNITY_CATEGORIES,
  RISK_LEVELS,
} from "@/lib/services/opportunities";
import { CURRENT_USER_ID } from "@/lib/auth";

const isDate = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

export async function GET() {
  try {
    return NextResponse.json({
      opportunities: await listOpportunities(CURRENT_USER_ID),
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not load opportunities.", detail: String(err) },
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

  const title = typeof b.title === "string" ? b.title.trim() : "";
  if (!title) {
    return NextResponse.json({ error: "Title is required." }, { status: 400 });
  }
  const category = OPPORTUNITY_CATEGORIES.includes(b.category as never)
    ? (b.category as (typeof OPPORTUNITY_CATEGORIES)[number])
    : "other";
  const estimatedRisk = RISK_LEVELS.includes(b.estimatedRisk as never)
    ? (b.estimatedRisk as (typeof RISK_LEVELS)[number])
    : null;

  let potentialValue: string | null = null;
  if (b.potentialValue !== undefined && b.potentialValue !== null && b.potentialValue !== "") {
    const v = Number(b.potentialValue);
    if (!Number.isFinite(v) || v < 0) {
      return NextResponse.json({ error: "Invalid potential value." }, { status: 400 });
    }
    potentialValue = String(v);
  }

  try {
    const row = await createOpportunity({
      userId: CURRENT_USER_ID,
      title,
      category,
      summary: typeof b.summary === "string" && b.summary ? b.summary : null,
      potentialValue,
      estimatedRisk,
      timeWindowEnd: isDate(b.timeWindowEnd) ? b.timeWindowEnd : null,
      generatedBy: "manual",
    });
    return NextResponse.json({ opportunity: row }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not create opportunity.", detail: String(err) },
      { status: 500 },
    );
  }
}
