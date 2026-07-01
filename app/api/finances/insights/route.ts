/* GET /api/finances/insights — Finance 1B.5B.
 * Owner-scoped, READ-ONLY deterministic spending insights + opportunity cards for
 * a bounded period. Mutates no finance-domain record and exposes no secrets. */

import { NextResponse } from "next/server";
import { computeInsights, type PeriodKey } from "@/lib/services/insights";
import { CURRENT_USER_ID } from "@/lib/auth";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const period = (url.searchParams.get("period") ?? "current_month") as PeriodKey;
  const type = url.searchParams.get("type") ?? undefined;
  const includeLowConfidence = url.searchParams.get("includeLow") === "true";
  try {
    return NextResponse.json(await computeInsights(CURRENT_USER_ID, { period, type, includeLowConfidence }));
  } catch {
    return NextResponse.json({ error: "Could not load insights." }, { status: 500 });
  }
}
