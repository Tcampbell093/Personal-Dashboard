/* POST /api/finances/insights/[id]/restore — Finance 1B.5B.
 * Undo a dismissal (delete the dismissal row). Changes only dismissal state. */

import { NextResponse } from "next/server";
import { restoreInsight, InsightError } from "@/lib/services/insights";
import { CURRENT_USER_ID } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Ctx) {
  const key = decodeURIComponent((await params).id);
  try {
    return NextResponse.json(await restoreInsight(CURRENT_USER_ID, key));
  } catch (e) {
    if (e instanceof InsightError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Could not restore the insight." }, { status: 500 });
  }
}
