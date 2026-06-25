/* /api/finances/income-schedules/[id] — Finance 1A.4: edit schedule fields, set
 * its split allocations, or delete it. Edits regenerate FUTURE scheduled
 * occurrences (received/skipped/cancelled/past are preserved). */

import { NextResponse } from "next/server";
import {
  updateSchedule,
  setScheduleAllocations,
  deleteSchedule,
  type ScheduleInput,
} from "@/lib/services/income-schedules";
import { FinanceError, type AllocationInput } from "@/lib/services/finances";
import { CURRENT_USER_ID } from "@/lib/auth";
import { localToday } from "@/lib/time";

type Ctx = { params: Promise<{ id: string }> };
function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const numOrNull = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const intOrNull = (v: unknown): number | null => {
  const n = numOrNull(v);
  return n != null && Number.isInteger(n) ? n : null;
};

function parseAllocations(raw: unknown): AllocationInput[] | Error {
  if (!Array.isArray(raw)) return new Error("Allocations must be an array.");
  const types = new Set(["fixed", "percent", "remainder"]);
  const out: AllocationInput[] = [];
  for (const item of raw) {
    const a = item as Record<string, unknown>;
    const accountId = Number(a.accountId);
    if (!Number.isInteger(accountId) || accountId <= 0) return new Error("Invalid allocation account.");
    if (typeof a.allocationType !== "string" || !types.has(a.allocationType)) return new Error("Invalid allocation type.");
    let value: number | null = null;
    if (a.allocationType !== "remainder") {
      const v = Number(a.value);
      if (!Number.isFinite(v)) return new Error("Allocation value must be a number.");
      value = v;
    }
    out.push({ accountId, allocationType: a.allocationType as AllocationInput["allocationType"], value });
  }
  return out;
}

function err(e: unknown) {
  if (e instanceof FinanceError) return NextResponse.json({ error: e.message }, { status: e.status });
  return NextResponse.json({ error: "Could not update schedule.", detail: String(e) }, { status: 500 });
}

export async function PATCH(request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) return NextResponse.json({ error: "Invalid schedule id." }, { status: 400 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  const today = localToday();

  // Split allocations take precedence (sets split mode + regenerates occurrences).
  if ("allocations" in b) {
    const allocs = parseAllocations(b.allocations);
    if (allocs instanceof Error) return NextResponse.json({ error: allocs.message }, { status: 400 });
    try {
      const row = await setScheduleAllocations(CURRENT_USER_ID, id, allocs, today);
      return NextResponse.json({ schedule: row });
    } catch (e) {
      return err(e);
    }
  }

  if (b.anchorDate !== undefined && !isDate(b.anchorDate)) {
    return NextResponse.json({ error: "Invalid anchor date." }, { status: 400 });
  }
  if (b.endDate !== undefined && b.endDate !== null && b.endDate !== "" && !isDate(b.endDate)) {
    return NextResponse.json({ error: "Invalid end date." }, { status: 400 });
  }

  const patch: Partial<ScheduleInput> = {};
  if (typeof b.source === "string") patch.source = b.source;
  if (typeof b.cadence === "string") patch.cadence = b.cadence;
  if (isDate(b.anchorDate)) patch.anchorDate = b.anchorDate;
  if (typeof b.estimateType === "string") patch.estimateType = b.estimateType;
  if (b.expectedAmount !== undefined) patch.expectedAmount = numOrNull(b.expectedAmount) ?? 0;
  if ("expectedMin" in b) patch.expectedMin = numOrNull(b.expectedMin);
  if ("expectedMax" in b) patch.expectedMax = numOrNull(b.expectedMax);
  if ("destinationAccountId" in b) patch.destinationAccountId = intOrNull(b.destinationAccountId);
  if ("dayOfMonth" in b) patch.dayOfMonth = intOrNull(b.dayOfMonth);
  if ("dayA" in b) patch.dayA = intOrNull(b.dayA);
  if ("dayB" in b) patch.dayB = intOrNull(b.dayB);
  if (b.isPayday !== undefined) patch.isPayday = Boolean(b.isPayday);
  if (b.active !== undefined) patch.active = Boolean(b.active);
  if ("endDate" in b) patch.endDate = isDate(b.endDate) ? b.endDate : null;

  try {
    const row = await updateSchedule(CURRENT_USER_ID, id, patch, today);
    return NextResponse.json({ schedule: row });
  } catch (e) {
    return err(e);
  }
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) return NextResponse.json({ error: "Invalid schedule id." }, { status: 400 });
  try {
    const result = await deleteSchedule(CURRENT_USER_ID, id, localToday());
    if (!result) return NextResponse.json({ error: "Schedule not found." }, { status: 404 });
    // mode = "archived" (had occurrences/history → preserved) | "deleted" (unused).
    return NextResponse.json({ ok: true, mode: result.mode });
  } catch (e) {
    return err(e);
  }
}
