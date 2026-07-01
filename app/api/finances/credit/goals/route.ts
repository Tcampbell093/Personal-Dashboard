/* /api/finances/credit/goals — Finance 1C.0A. Owner-entered credit goals.
 *   GET → all goals.  POST → create a goal (target validated per goal type). */

import { NextResponse } from "next/server";
import { listGoals, createGoal, CreditError } from "@/lib/services/credit";
import { CURRENT_USER_ID } from "@/lib/auth";

export async function GET() {
  try { return NextResponse.json({ goals: await listGoals(CURRENT_USER_ID) }); }
  catch { return NextResponse.json({ error: "Could not load goals." }, { status: 500 }); }
}

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid body." }, { status: 400 }); }
  try { return NextResponse.json({ goal: await createGoal(CURRENT_USER_ID, body as never) }); }
  catch (e) {
    if (e instanceof CreditError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Could not create the goal." }, { status: 500 });
  }
}
