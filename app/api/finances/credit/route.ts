/* GET /api/finances/credit — Finance 1C.0A.
 * Owner-scoped, READ-ONLY deterministic credit + financial-health overview.
 * Manual data only; no bureau/Credit Karma connection; mutates no record. */

import { NextResponse } from "next/server";
import { computeCreditOverview } from "@/lib/services/credit";
import { CURRENT_USER_ID } from "@/lib/auth";

export async function GET() {
  try {
    return NextResponse.json(await computeCreditOverview(CURRENT_USER_ID));
  } catch {
    return NextResponse.json({ error: "Could not load the credit overview." }, { status: 500 });
  }
}
