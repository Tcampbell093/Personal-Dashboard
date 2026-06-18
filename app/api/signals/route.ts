/* /api/signals — list + create signals. */

import { NextResponse } from "next/server";
import { createSignal, listSignals, SIGNAL_TYPES } from "@/lib/services/signals";
import { CURRENT_USER_ID } from "@/lib/auth";

const isDate = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

export async function GET() {
  try {
    return NextResponse.json({ signals: await listSignals(CURRENT_USER_ID) });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not load signals.", detail: String(err) },
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
  const type = SIGNAL_TYPES.includes(b.type as never)
    ? (b.type as (typeof SIGNAL_TYPES)[number])
    : "other";

  try {
    const row = await createSignal({
      userId: CURRENT_USER_ID,
      title,
      type,
      location: typeof b.location === "string" && b.location ? b.location : null,
      eventDate: isDate(b.eventDate) ? b.eventDate : null,
      summary: typeof b.summary === "string" && b.summary ? b.summary : null,
    });
    return NextResponse.json({ signal: row }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not create signal.", detail: String(err) },
      { status: 500 },
    );
  }
}
