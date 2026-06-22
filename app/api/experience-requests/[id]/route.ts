/* /api/experience-requests/[id] — read, edit constraints, soft-delete.
 * Editing startingLocation here is request-specific and never writes back to
 * user_preferences.homeArea (this route only touches experience_requests). */

import { NextResponse } from "next/server";
import {
  getRequest,
  updateRequest,
  deleteRequest,
  toRequestView,
  ENERGY_LEVELS,
  PHYSICAL_DIFFICULTIES,
  INTERPRETED_CONSTRAINT_FIELDS,
  type NewExperienceRequest,
} from "@/lib/services/experience-requests";
import { CURRENT_USER_ID } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };
const parseId = (raw: string): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const isDate = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const INVALID = Symbol("invalid");
function money(v: unknown): string | null | typeof INVALID {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? String(n) : INVALID;
}
function nonNegInt(v: unknown): number | null | typeof INVALID {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : INVALID;
}
/** undefined/null/"" -> null; valid approved value -> value; else INVALID. */
function enumOrNull(v: unknown, allowed: readonly string[]): string | null | typeof INVALID {
  if (v === undefined || v === null || v === "") return null;
  return typeof v === "string" && allowed.includes(v) ? v : INVALID;
}

export async function GET(_request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  try {
    const row = await getRequest(CURRENT_USER_ID, id);
    if (!row) return NextResponse.json({ error: "Request not found." }, { status: 404 });
    return NextResponse.json({ request: toRequestView(row) });
  } catch (err) {
    return NextResponse.json({ error: "Could not load request.", detail: String(err) }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) return NextResponse.json({ error: "Invalid id." }, { status: 400 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  const patch: Partial<NewExperienceRequest> = {};

  if (typeof b.requestText === "string") {
    const t = b.requestText.trim();
    if (!t) return NextResponse.json({ error: "Request text cannot be empty." }, { status: 400 });
    patch.requestText = t;
  }
  if ("availableDate" in b) {
    if (b.availableDate && !isDate(b.availableDate)) {
      return NextResponse.json({ error: "Invalid available date." }, { status: 400 });
    }
    patch.availableDate = isDate(b.availableDate) ? b.availableDate : null;
  }
  if ("availableTimeText" in b)
    patch.availableTimeText = typeof b.availableTimeText === "string" && b.availableTimeText ? b.availableTimeText : null;
  if ("budgetMax" in b) {
    const v = money(b.budgetMax);
    if (v === INVALID) return NextResponse.json({ error: "Budget must be a non-negative number." }, { status: 400 });
    patch.budgetMax = v;
  }
  if ("startingLocation" in b)
    patch.startingLocation = typeof b.startingLocation === "string" && b.startingLocation ? b.startingLocation : null;
  if ("maxTravelMiles" in b) {
    const v = nonNegInt(b.maxTravelMiles);
    if (v === INVALID) return NextResponse.json({ error: "Travel miles must be a non-negative integer." }, { status: 400 });
    patch.maxTravelMiles = v;
  }
  if ("maxTravelMinutes" in b) {
    const v = nonNegInt(b.maxTravelMinutes);
    if (v === INVALID) return NextResponse.json({ error: "Travel minutes must be a non-negative integer." }, { status: 400 });
    patch.maxTravelMinutes = v;
  }
  if ("energyLevel" in b) {
    const v = enumOrNull(b.energyLevel, ENERGY_LEVELS);
    if (v === INVALID) {
      return NextResponse.json({ error: "Invalid energy level." }, { status: 400 });
    }
    patch.energyLevel = v as never;
  }
  if ("desiredFeeling" in b)
    patch.desiredFeeling = typeof b.desiredFeeling === "string" && b.desiredFeeling ? b.desiredFeeling : null;
  if ("maxPhysicalDifficulty" in b) {
    const v = enumOrNull(b.maxPhysicalDifficulty, PHYSICAL_DIFFICULTIES);
    if (v === INVALID) {
      return NextResponse.json({ error: "Invalid physical difficulty." }, { status: 400 });
    }
    patch.maxPhysicalDifficulty = v as never;
  }
  if ("interests" in b)
    patch.interests = Array.isArray(b.interests) ? b.interests.filter((x): x is string => typeof x === "string") : [];
  if ("exclusions" in b)
    patch.exclusions = Array.isArray(b.exclusions) ? b.exclusions.filter((x): x is string => typeof x === "string") : [];

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  // Provenance (Build 2A): editing ANY interpreted constraint on an AI-derived
  // request means the values are no longer purely AI — reset source to manual
  // and clear provider/model. Editing requestText alone changes nothing here,
  // and never reruns AI. A never-interpreted request keeps Build 1 behavior.
  const touchesConstraint = Object.keys(patch).some((k) =>
    (INTERPRETED_CONSTRAINT_FIELDS as readonly string[]).includes(k),
  );
  let current;
  try {
    current = await getRequest(CURRENT_USER_ID, id);
  } catch (err) {
    return NextResponse.json({ error: "Could not load request.", detail: String(err) }, { status: 500 });
  }
  if (!current) return NextResponse.json({ error: "Request not found." }, { status: 404 });
  if (touchesConstraint && current.interpretationSource === "ai") {
    patch.interpretationSource = "manual";
    patch.interpretationProvider = null;
    patch.interpretationModel = null;
  }

  try {
    const row = await updateRequest(CURRENT_USER_ID, id, patch);
    if (!row) return NextResponse.json({ error: "Request not found." }, { status: 404 });
    return NextResponse.json({ request: toRequestView(row) });
  } catch (err) {
    return NextResponse.json({ error: "Could not update request.", detail: String(err) }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  try {
    const row = await deleteRequest(CURRENT_USER_ID, id);
    if (!row) return NextResponse.json({ error: "Request not found." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: "Could not delete request.", detail: String(err) }, { status: 500 });
  }
}
