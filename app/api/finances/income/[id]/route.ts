/* /api/finances/income/[id] — edit fields, set destination/split, soft-delete.
 *
 * Finance 1A.2: a scheduled income's destination is set here — either a single
 * `destinationAccountId` or a `split` allocation set. Receiving/reversing the
 * income (which moves balances) lives in the dedicated /receive and /reverse
 * routes. Field edits (source/amount/payDate/isPayday) never move balances. */

import { NextResponse } from "next/server";
import {
  updateIncome,
  deleteIncome,
  setIncomeDestination,
  setIncomeAllocations,
  setIncomeStatus,
  OCCURRENCE_STATUSES,
  FinanceError,
  type AllocationInput,
  type NewIncome,
} from "@/lib/services/finances";
import { CURRENT_USER_ID } from "@/lib/auth";

const isDate = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

type Ctx = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseAllocations(raw: unknown): AllocationInput[] | Error {
  if (!Array.isArray(raw)) return new Error("Allocations must be an array.");
  const types = new Set(["fixed", "percent", "remainder"]);
  const out: AllocationInput[] = [];
  for (const item of raw) {
    const a = item as Record<string, unknown>;
    const accountId = Number(a.accountId);
    if (!Number.isInteger(accountId) || accountId <= 0) return new Error("Invalid allocation account.");
    if (typeof a.allocationType !== "string" || !types.has(a.allocationType))
      return new Error("Invalid allocation type.");
    let value: number | null = null;
    if (a.allocationType !== "remainder") {
      const v = Number(a.value);
      if (!Number.isFinite(v)) return new Error("Allocation value must be a number.");
      value = v;
    }
    out.push({
      accountId,
      allocationType: a.allocationType as AllocationInput["allocationType"],
      value,
    });
  }
  return out;
}

function financeErr(err: unknown) {
  if (err instanceof FinanceError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  return NextResponse.json(
    { error: "Could not update income.", detail: String(err) },
    { status: 500 },
  );
}

export async function PATCH(request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json({ error: "Invalid income id." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  // Finance 1A.4: skip / cancel / un-skip one occurrence (not received → use /receive).
  if (typeof b.status === "string") {
    if (!(OCCURRENCE_STATUSES as readonly string[]).includes(b.status)) {
      return NextResponse.json(
        { error: "Status must be scheduled, skipped, or cancelled (receive via the receive action)." },
        { status: 400 },
      );
    }
    try {
      const row = await setIncomeStatus(CURRENT_USER_ID, id, b.status as (typeof OCCURRENCE_STATUSES)[number]);
      return NextResponse.json({ income: row });
    } catch (err) {
      return financeErr(err);
    }
  }

  // Split allocations (sets split mode) take precedence over a single destination.
  if ("allocations" in b) {
    const allocs = parseAllocations(b.allocations);
    if (allocs instanceof Error) {
      return NextResponse.json({ error: allocs.message }, { status: 400 });
    }
    try {
      const row = await setIncomeAllocations(CURRENT_USER_ID, id, allocs);
      return NextResponse.json({ income: row });
    } catch (err) {
      return financeErr(err);
    }
  }
  if ("destinationAccountId" in b) {
    const raw = b.destinationAccountId;
    let accountId: number | null = null;
    if (raw !== null && raw !== "" && raw !== undefined) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        return NextResponse.json({ error: "Invalid destination account." }, { status: 400 });
      }
      accountId = n;
    }
    try {
      const row = await setIncomeDestination(CURRENT_USER_ID, id, accountId);
      return NextResponse.json({ income: row });
    } catch (err) {
      return financeErr(err);
    }
  }

  // Descriptive field edits.
  const patch: Partial<NewIncome> = {};
  if (typeof b.source === "string") {
    const source = b.source.trim();
    if (!source) {
      return NextResponse.json({ error: "Source cannot be empty." }, { status: 400 });
    }
    patch.source = source;
  }
  if (b.expectedAmount !== undefined) {
    const amount = Number(b.expectedAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      return NextResponse.json({ error: "Invalid amount." }, { status: 400 });
    }
    patch.expectedAmount = String(amount);
  }
  if ("payDate" in b) {
    if (!isDate(b.payDate)) {
      return NextResponse.json({ error: "Invalid pay date." }, { status: 400 });
    }
    patch.payDate = b.payDate;
  }
  if (b.isPayday !== undefined) patch.isPayday = Boolean(b.isPayday);
  if ("estimateType" in b && typeof b.estimateType === "string") patch.estimateType = b.estimateType as NewIncome["estimateType"];
  if ("expectedMin" in b) patch.expectedMin = b.expectedMin == null || b.expectedMin === "" ? null : String(Number(b.expectedMin));
  if ("expectedMax" in b) patch.expectedMax = b.expectedMax == null || b.expectedMax === "" ? null : String(Number(b.expectedMax));

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }
  // Finance 1A.4 correction: a field edit overrides this individual occurrence so
  // a later schedule edit never overwrites it.
  patch.isOverridden = true;

  try {
    const row = await updateIncome(CURRENT_USER_ID, id, patch);
    if (!row) {
      return NextResponse.json({ error: "Income not found." }, { status: 404 });
    }
    return NextResponse.json({ income: row });
  } catch (err) {
    return financeErr(err);
  }
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json({ error: "Invalid income id." }, { status: 400 });
  }
  try {
    const row = await deleteIncome(CURRENT_USER_ID, id);
    if (!row) {
      return NextResponse.json({ error: "Income not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not delete income.", detail: String(err) },
      { status: 500 },
    );
  }
}
