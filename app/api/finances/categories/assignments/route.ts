/* GET /api/finances/categories/assignments — Finance 1B.5A.
 * The Categorize-transactions review queue (uncategorized + suggested by default),
 * with bounded filters. Read-only; mutates nothing. */

import { NextResponse } from "next/server";
import { getCategoryReviewQueue } from "@/lib/services/categories";
import { CURRENT_USER_ID } from "@/lib/auth";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const filter = url.searchParams.get("filter") ?? "review";
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw && /^\d+$/.test(limitRaw) ? Number(limitRaw) : 10;
  const catRaw = url.searchParams.get("category");
  const categoryId = catRaw && /^\d+$/.test(catRaw) ? Number(catRaw) : undefined;
  try {
    return NextResponse.json({ transactions: await getCategoryReviewQueue(CURRENT_USER_ID, { filter, limit, categoryId }) });
  } catch { return NextResponse.json({ error: "Could not load transactions." }, { status: 500 }); }
}
