/* /api/obligations — list and create obligations.
 * Mirrors /api/tasks: explicit validation, user resolved server-side. */

import { NextResponse } from "next/server";
import { createObligation, listObligations } from "@/lib/services/obligations";
import { CURRENT_USER_ID } from "@/lib/auth";

export const OBLIGATION_TYPES = [
  "appointment",
  "meeting",
  "work_shift",
  "renewal",
  "application_deadline",
  "payment",
  "personal_commitment",
  "event",
  "other_deadline",
] as const;

export const IMPORTANCE = ["low", "medium", "high", "critical"] as const;

// "YYYY-MM-DD"
const isDate = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

export async function GET() {
  try {
    const rows = await listObligations(CURRENT_USER_ID);
    return NextResponse.json({ obligations: rows });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not load obligations.", detail: String(err) },
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
  if (!isDate(b.startDate)) {
    return NextResponse.json(
      { error: "A valid start date (YYYY-MM-DD) is required." },
      { status: 400 },
    );
  }

  const type = OBLIGATION_TYPES.includes(b.type as never)
    ? (b.type as (typeof OBLIGATION_TYPES)[number])
    : "appointment";
  const obligationImportance = IMPORTANCE.includes(b.importance as never)
    ? (b.importance as (typeof IMPORTANCE)[number])
    : "medium";

  try {
    const row = await createObligation({
      userId: CURRENT_USER_ID,
      title,
      type,
      startDate: b.startDate,
      startTime: typeof b.startTime === "string" && b.startTime ? b.startTime : null,
      location: typeof b.location === "string" && b.location ? b.location : null,
      importance: obligationImportance,
    });
    return NextResponse.json({ obligation: row }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not create obligation.", detail: String(err) },
      { status: 500 },
    );
  }
}
