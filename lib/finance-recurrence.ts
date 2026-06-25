/* Finance 1A.4 — pure recurrence date generation (no DB; client + server safe).
 *
 * Produces the concrete calendar dates of a recurring income schedule within a
 * window. Dates are plain YYYY-MM-DD; all math is UTC-anchored so a calendar date
 * is timezone-agnostic (the "today" cutoff is supplied by the caller from the app
 * timezone). A monthly/semimonthly day beyond a month's last day resolves to the
 * month's LAST calendar day (so the 31st = last day; Feb handles leap years). */

export type IncomeCadence = "one_time" | "weekly" | "biweekly" | "semimonthly" | "monthly";

export interface RecurrenceRule {
  cadence: IncomeCadence;
  anchorDate: string; // YYYY-MM-DD
  endDate?: string | null;
  dayOfMonth?: number | null; // monthly
  dayA?: number | null; // semimonthly
  dayB?: number | null; // semimonthly
}

const MS = 86_400_000;
const parse = (iso: string): Date => new Date(iso + "T00:00:00Z");
const fmt = (d: Date): string => d.toISOString().slice(0, 10);

export function addDays(iso: string, n: number): string {
  const d = parse(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
}

/** Number of days in `month1` (1-12) of `year` — leap years handled by JS Date. */
export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** A YYYY-MM-DD for (year, month1, day), clamping `day` to the month's last day. */
function dateOf(year: number, month1: number, day: number): string {
  const d = Math.min(day, daysInMonth(year, month1));
  return `${year}-${String(month1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export function weekdayOf(iso: string): number {
  return parse(iso).getUTCDay();
}
export function weekdayName(iso: string): string {
  return WEEKDAYS[weekdayOf(iso)];
}

/**
 * The concrete occurrence dates of `rule` within [from, through], clamped to the
 * anchor and optional end date. Deterministic, de-duplicated, sorted ascending.
 */
export function generateOccurrenceDates(
  rule: RecurrenceRule,
  from: string,
  through: string,
): string[] {
  const anchor = rule.anchorDate;
  const end = rule.endDate ?? null;
  const lo = from > anchor ? from : anchor; // never before the anchor
  const hi = end && end < through ? end : through;
  if (hi < lo) return [];

  const out: string[] = [];
  const push = (d: string) => {
    if (d >= lo && d <= hi) out.push(d);
  };

  if (rule.cadence === "one_time") {
    push(anchor);
  } else if (rule.cadence === "weekly" || rule.cadence === "biweekly") {
    const step = rule.cadence === "weekly" ? 7 : 14;
    const anchorMs = parse(anchor).getTime();
    let k = Math.max(0, Math.floor((parse(lo).getTime() - anchorMs) / (step * MS)));
    let d = addDays(anchor, k * step);
    while (d < lo) {
      k++;
      d = addDays(anchor, k * step);
    }
    let guard = 0;
    while (d <= hi && guard++ < 2000) {
      out.push(d);
      k++;
      d = addDays(anchor, k * step);
    }
  } else if (rule.cadence === "monthly") {
    const day = rule.dayOfMonth ?? parse(anchor).getUTCDate();
    let y = parse(lo).getUTCFullYear();
    let m = parse(lo).getUTCMonth() + 1;
    let guard = 0;
    while (guard++ < 600) {
      push(dateOf(y, m, day));
      m++;
      if (m > 12) { m = 1; y++; }
      if (`${y}-${String(m).padStart(2, "0")}-01` > hi) break;
    }
  } else if (rule.cadence === "semimonthly") {
    const a = rule.dayA ?? 1;
    const b = rule.dayB ?? 15;
    let y = parse(lo).getUTCFullYear();
    let m = parse(lo).getUTCMonth() + 1;
    let guard = 0;
    while (guard++ < 600) {
      push(dateOf(y, m, a));
      push(dateOf(y, m, b));
      m++;
      if (m > 12) { m = 1; y++; }
      if (`${y}-${String(m).padStart(2, "0")}-01` > hi) break;
    }
  }

  return [...new Set(out)].sort();
}

/** The single next occurrence date strictly on/after `from` (or null). */
export function nextOccurrenceDate(rule: RecurrenceRule, from: string): string | null {
  // A 2-year look-ahead is plenty for any supported cadence.
  return generateOccurrenceDates(rule, from, addDays(from, 730))[0] ?? null;
}
