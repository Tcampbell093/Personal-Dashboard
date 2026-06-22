/* /api/experience-requests — list + create a draft request. */

import { NextResponse } from "next/server";
import {
  createRequest,
  listRequests,
  toRequestViews,
  ENERGY_LEVELS,
  PHYSICAL_DIFFICULTIES,
} from "@/lib/services/experience-requests";
import { CURRENT_USER_ID } from "@/lib/auth";

const isDate = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Returns the numeric string for a non-negative money value, null if absent,
 * or the symbol `INVALID` if present but not a valid non-negative number. */
const INVALID = Symbol("invalid");
function money(v: unknown): string | null | typeof INVALID {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? String(n) : INVALID;
}
/** Normalizes an optional enum value: undefined/null/"" -> null; a valid
 * approved value -> that value; any other non-empty value -> INVALID. */
function enumOrNull(v: unknown, allowed: readonly string[]): string | null | typeof INVALID {
  if (v === undefined || v === null || v === "") return null;
  return typeof v === "string" && allowed.includes(v) ? v : INVALID;
}
function nonNegInt(v: unknown): number | null | typeof INVALID {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : INVALID;
}
function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export async function GET() {
  try {
    const rows = await listRequests(CURRENT_USER_ID);
    return NextResponse.json({ requests: toRequestViews(rows) });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not load experience requests.", detail: String(err) },
      { status: 500 },
    );
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

  const requestText = typeof b.requestText === "string" ? b.requestText.trim() : "";
  if (!requestText) {
    return NextResponse.json({ error: "Request text is required." }, { status: 400 });
  }
  if (b.availableDate !== undefined && b.availableDate !== null && b.availableDate !== "" && !isDate(b.availableDate)) {
    return NextResponse.json({ error: "Invalid available date." }, { status: 400 });
  }
  const budgetMax = money(b.budgetMax);
  if (budgetMax === INVALID) {
    return NextResponse.json({ error: "Budget must be a non-negative number." }, { status: 400 });
  }
  const maxTravelMiles = nonNegInt(b.maxTravelMiles);
  if (maxTravelMiles === INVALID) {
    return NextResponse.json({ error: "Travel miles must be a non-negative integer." }, { status: 400 });
  }
  const maxTravelMinutes = nonNegInt(b.maxTravelMinutes);
  if (maxTravelMinutes === INVALID) {
    return NextResponse.json({ error: "Travel minutes must be a non-negative integer." }, { status: 400 });
  }
  const energyLevel = enumOrNull(b.energyLevel, ENERGY_LEVELS);
  if (energyLevel === INVALID) {
    return NextResponse.json({ error: "Invalid energy level." }, { status: 400 });
  }
  const maxPhysicalDifficulty = enumOrNull(b.maxPhysicalDifficulty, PHYSICAL_DIFFICULTIES);
  if (maxPhysicalDifficulty === INVALID) {
    return NextResponse.json({ error: "Invalid physical difficulty." }, { status: 400 });
  }

  try {
    const row = await createRequest({
      userId: CURRENT_USER_ID,
      requestText,
      availableDate: isDate(b.availableDate) ? b.availableDate : null,
      availableTimeText: typeof b.availableTimeText === "string" && b.availableTimeText ? b.availableTimeText : null,
      budgetMax,
      startingLocation: typeof b.startingLocation === "string" && b.startingLocation ? b.startingLocation : null,
      maxTravelMiles,
      maxTravelMinutes,
      energyLevel: energyLevel as never,
      desiredFeeling: typeof b.desiredFeeling === "string" && b.desiredFeeling ? b.desiredFeeling : null,
      maxPhysicalDifficulty: maxPhysicalDifficulty as never,
      interests: stringArray(b.interests),
      exclusions: stringArray(b.exclusions),
    });
    return NextResponse.json({ request: row }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not create experience request.", detail: String(err) },
      { status: 500 },
    );
  }
}
