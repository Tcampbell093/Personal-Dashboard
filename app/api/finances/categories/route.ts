/* /api/finances/categories — Finance 1B.5A. Owner-scoped categories.
 *   GET  → active (and optionally inactive) categories.
 *   POST → create a custom owner category. */

import { NextResponse } from "next/server";
import { listCategories, createCategory, CategoryError } from "@/lib/services/categories";
import { CURRENT_USER_ID } from "@/lib/auth";

export async function GET(request: Request) {
  const includeInactive = new URL(request.url).searchParams.get("includeInactive") === "true";
  try {
    return NextResponse.json({ categories: await listCategories(CURRENT_USER_ID, { includeInactive }) });
  } catch { return NextResponse.json({ error: "Could not load categories." }, { status: 500 }); }
}

export async function POST(request: Request) {
  let body: { name?: unknown; kind?: unknown } = {};
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid body." }, { status: 400 }); }
  const kind = body.kind === "income" || body.kind === "transfer" || body.kind === "neutral" ? body.kind : "expense";
  try {
    return NextResponse.json({ category: await createCategory(CURRENT_USER_ID, { name: String(body.name ?? ""), kind }) });
  } catch (e) {
    if (e instanceof CategoryError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Could not create the category." }, { status: 500 });
  }
}
