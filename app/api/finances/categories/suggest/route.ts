/* POST /api/finances/categories/suggest — Finance 1B.5A.
 * Deterministically (re)generate category suggestions. Mutates no finance record
 * (only category-assignment metadata). Returns counts + the refreshed queue. */

import { NextResponse } from "next/server";
import { generateCategorySuggestions, getCategoryReviewQueue } from "@/lib/services/categories";
import { CURRENT_USER_ID } from "@/lib/auth";

export async function POST() {
  try {
    const result = await generateCategorySuggestions(CURRENT_USER_ID);
    const transactions = await getCategoryReviewQueue(CURRENT_USER_ID, { filter: "review", limit: 10 });
    return NextResponse.json({ ...result, transactions });
  } catch { return NextResponse.json({ error: "Could not generate suggestions." }, { status: 500 }); }
}
