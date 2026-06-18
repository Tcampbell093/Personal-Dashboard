/* /api/interest — list + create interest-watch items. */

import { NextResponse } from "next/server";
import { createInterestItem, listInterestItems } from "@/lib/services/interest";
import { CURRENT_USER_ID } from "@/lib/auth";

export async function GET() {
  try {
    return NextResponse.json({ interest: await listInterestItems(CURRENT_USER_ID) });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not load interest items.", detail: String(err) },
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
  const topic = typeof b.topic === "string" && b.topic.trim() ? b.topic.trim() : "General";

  try {
    const row = await createInterestItem({
      userId: CURRENT_USER_ID,
      topic,
      title,
      source: typeof b.source === "string" && b.source ? b.source : null,
    });
    return NextResponse.json({ interest: row }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not create interest item.", detail: String(err) },
      { status: 500 },
    );
  }
}
