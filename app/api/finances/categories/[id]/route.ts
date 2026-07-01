/* PATCH /api/finances/categories/[id] — Finance 1B.5A.
 * Rename, reorder, or activate/deactivate (deactivation is blocked while in use;
 * Uncategorized cannot be renamed or deactivated). Never hard-deletes. */

import { NextResponse } from "next/server";
import { updateCategory, CategoryError } from "@/lib/services/categories";
import { CURRENT_USER_ID } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Ctx) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid category id." }, { status: 400 });
  let body: { name?: unknown; sortOrder?: unknown; isActive?: unknown } = {};
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid body." }, { status: 400 }); }
  const patch: { name?: string; sortOrder?: number; isActive?: boolean } = {};
  if (typeof body.name === "string") patch.name = body.name;
  if (typeof body.sortOrder === "number") patch.sortOrder = body.sortOrder;
  if (typeof body.isActive === "boolean") patch.isActive = body.isActive;
  try {
    return NextResponse.json({ category: await updateCategory(CURRENT_USER_ID, id, patch) });
  } catch (e) {
    if (e instanceof CategoryError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Could not update the category." }, { status: 500 });
  }
}
