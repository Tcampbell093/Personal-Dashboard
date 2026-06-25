/* /api/finances/income-schedules — Finance 1A.4: list + create recurring income
 * schedules. Creating a schedule materializes its upcoming occurrences. */

import { NextResponse } from "next/server";
import {
  createSchedule,
  listSchedules,
  listScheduleAllocations,
  scheduleAllocationsBySchedule,
  toScheduleViews,
  type ScheduleInput,
} from "@/lib/services/income-schedules";
import { FinanceError } from "@/lib/services/finances";
import { CURRENT_USER_ID } from "@/lib/auth";
import { localToday } from "@/lib/time";

const numOrNull = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const intOrNull = (v: unknown): number | null => {
  const n = numOrNull(v);
  return n != null && Number.isInteger(n) ? n : null;
};

export async function GET() {
  try {
    const today = localToday();
    const [schedules, allocRows] = await Promise.all([
      listSchedules(CURRENT_USER_ID),
      listScheduleAllocations(CURRENT_USER_ID),
    ]);
    return NextResponse.json({
      schedules: toScheduleViews(schedules, scheduleAllocationsBySchedule(allocRows), today),
    });
  } catch (err) {
    return NextResponse.json({ error: "Could not load schedules.", detail: String(err) }, { status: 500 });
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
  const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!isDate(b.anchorDate)) {
    return NextResponse.json({ error: "A valid anchor date (YYYY-MM-DD) is required." }, { status: 400 });
  }
  if (b.endDate !== undefined && b.endDate !== null && b.endDate !== "" && !isDate(b.endDate)) {
    return NextResponse.json({ error: "Invalid end date." }, { status: 400 });
  }

  const input: ScheduleInput = {
    source: typeof b.source === "string" ? b.source : "",
    cadence: typeof b.cadence === "string" ? b.cadence : "",
    anchorDate: b.anchorDate,
    expectedAmount: numOrNull(b.expectedAmount) ?? 0,
    estimateType: typeof b.estimateType === "string" ? b.estimateType : "fixed",
    expectedMin: numOrNull(b.expectedMin),
    expectedMax: numOrNull(b.expectedMax),
    destinationAccountId: intOrNull(b.destinationAccountId),
    dayOfMonth: intOrNull(b.dayOfMonth),
    dayA: intOrNull(b.dayA),
    dayB: intOrNull(b.dayB),
    isPayday: b.isPayday === undefined ? true : Boolean(b.isPayday),
    active: b.active === undefined ? true : Boolean(b.active),
    endDate: isDate(b.endDate) ? b.endDate : null,
  };

  try {
    const row = await createSchedule(CURRENT_USER_ID, input, localToday());
    return NextResponse.json({ schedule: row }, { status: 201 });
  } catch (err) {
    if (err instanceof FinanceError) return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: "Could not create schedule.", detail: String(err) }, { status: 500 });
  }
}
