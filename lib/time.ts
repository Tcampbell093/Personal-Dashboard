/* Centralized application time — the ONE place Home/Today and the deterministic
 * ranker derive "today". Uses the configured timezone (APP_TIME_ZONE, default
 * America/New_York) via built-in Intl APIs. An invalid timezone falls back
 * safely. Never mutates stored timestamps; this only derives local labels and
 * the local calendar date for daily-boundary comparisons. */

const FALLBACK_TZ = "America/New_York";

/** The effective app timezone: APP_TIME_ZONE if valid, else America/New_York. */
export function appTimeZone(): string {
  const tz = process.env.APP_TIME_ZONE?.trim();
  if (!tz) return FALLBACK_TZ;
  try {
    // Throws RangeError for an unknown/invalid timezone.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return FALLBACK_TZ;
  }
}

/** Local calendar date (YYYY-MM-DD) for `now` in the app timezone. */
export function localToday(now: Date = new Date()): string {
  // en-CA renders ISO-style YYYY-MM-DD parts.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: appTimeZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Local hour (0–23) for `now` in the app timezone. */
export function localHour(now: Date = new Date()): number {
  const h = new Intl.DateTimeFormat("en-US", {
    timeZone: appTimeZone(),
    hour: "numeric",
    hour12: false,
  }).format(now);
  return Number(h) % 24; // some runtimes render midnight as "24"
}

/** Part of day in the app timezone, for the greeting. */
export function partOfDay(now: Date = new Date()): "morning" | "afternoon" | "evening" {
  const h = localHour(now);
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  return "evening";
}

/** Long human date label ("Tuesday, June 23") in the app timezone. */
export function longDateLabel(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: appTimeZone(),
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(now);
}

/** Whole-day difference between a YYYY-MM-DD date and the local today (app tz).
 * Negative = overdue, 0 = due today, positive = future. Infinity if no date.
 * Pure integer-day math anchored on the local calendar date, so it is correct
 * across UTC/local midnight. */
export function localDaysUntil(dateStr: string | null, now: Date = new Date()): number {
  if (!dateStr) return Infinity;
  const today = localToday(now);
  const toUtcDay = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, (m ?? 1) - 1, d ?? 1) / 86_400_000;
  };
  return Math.round(toUtcDay(dateStr) - toUtcDay(today));
}
