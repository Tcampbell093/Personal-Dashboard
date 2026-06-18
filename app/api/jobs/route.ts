/* /api/jobs — list + create. */

import { NextResponse } from "next/server";
import { createJob, listJobs, WORK_ARRANGEMENTS } from "@/lib/services/jobs";
import { CURRENT_USER_ID } from "@/lib/auth";

export async function GET() {
  try {
    return NextResponse.json({ jobs: await listJobs(CURRENT_USER_ID) });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not load jobs.", detail: String(err) },
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
  const workArrangement = WORK_ARRANGEMENTS.includes(b.workArrangement as never)
    ? (b.workArrangement as (typeof WORK_ARRANGEMENTS)[number])
    : null;

  try {
    const row = await createJob({
      userId: CURRENT_USER_ID,
      title,
      company: typeof b.company === "string" && b.company ? b.company : null,
      location: typeof b.location === "string" && b.location ? b.location : null,
      workArrangement,
    });
    return NextResponse.json({ job: row }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not create job.", detail: String(err) },
      { status: 500 },
    );
  }
}
