/* =============================================================================
 * Daily Command Center — Slice 1: unified signal contract (read-only).
 *
 * The shared, deterministic `DailySignal` shape that grounded domain providers
 * emit. This is a CONTRACT + validation only — NO ranking, NO orchestration, NO
 * persistence, NO API, NO UI, NO AI. See docs/DAILY_COMMAND_CENTER_SPEC.md §4.
 *
 * Provenance is never flattened: `class` distinguishes observed facts,
 * deterministic calculations, inferred interpretations, and recommendations.
 * ===========================================================================*/

/* ---------------------------------------------------- bounded unions ------ */
export const DAILY_DOMAINS = ["tasks", "obligations", "bills", "finance", "credit", "spending", "goals", "data_quality", "experience"] as const;
export type DailyDomain = (typeof DAILY_DOMAINS)[number];

/** Provenance discriminator — MUST NOT be collapsed (spec §4). */
export const SIGNAL_CLASSES = ["observed_fact", "deterministic_calc", "inferred_interpretation", "recommendation"] as const;
export type SignalClass = (typeof SIGNAL_CLASSES)[number];

export const URGENCIES = ["low", "medium", "high"] as const;
export type Urgency = (typeof URGENCIES)[number];

export const CONFIDENCES = ["low", "medium", "high"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const REVERSIBILITIES = ["reversible", "hard_to_reverse", "irreversible"] as const;
export type Reversibility = (typeof REVERSIBILITIES)[number];

/** Signal types allowed per domain (validated — no free-form drift). */
export const SIGNAL_TYPES: Record<DailyDomain, readonly string[]> = {
  tasks: ["task_overdue", "task_due_soon"],
  obligations: ["obligation_overdue", "obligation_due_soon", "obligation_upcoming"],
  bills: ["bill_overdue", "bill_due_soon"],
  finance: ["projected_shortfall", "tight_cash_before_payday", "income_unconfirmed"],
  credit: ["score_change", "utilization_high", "utilization_progress", "payment_due_soon", "payment_overdue", "collection_unverified", "collection_resolution_progress", "recent_hard_inquiries", "thin_or_incomplete_profile", "cash_flow_conflict", "credit_action"],
  spending: ["spending_opportunity"],
  goals: ["goal_progress"],
  data_quality: ["uncategorized_transactions", "pending_matches", "stale_credit_score"],
  experience: ["planned_experience"],
} as const;

/* ------------------------------------------------ structured refs --------- */
/** Minimal structured source reference — enough to trace, deep-link, dedupe,
 * and link lifecycle later. NEVER carries tokens, raw payloads, or secrets. */
export interface SourceRef {
  service: string;          // logical service, e.g. "tasks", "finances.bills", "credit"
  table: string | null;     // DB table when applicable, e.g. "financial_entries"
  id: number | string | null; // entity id (null for aggregate/derived signals)
  label?: string;           // optional human label — nonsecret
}

export interface CapacityReqs {
  money?: number | null;         // dollars required
  timeMinutes?: number | null;   // rough effort
  scheduleConflict?: boolean | null; // known conflict, or null when unknown
}

/* ---------------------------------------------------- the signal ---------- */
export interface DailySignal {
  key: string;               // stable deterministic `{domain}:{signalType}:{entity}`
  domain: DailyDomain;
  signalType: string;        // must be in SIGNAL_TYPES[domain]
  class: SignalClass;        // provenance — never flattened
  title: string;
  summary: string;
  evidence: string;          // human-readable, nonsecret
  sourceRefs: SourceRef[];
  observedDate: string;      // ISO YYYY-MM-DD — when observed as-of
  effectiveDate: string | null; // deadline / due date, or null
  urgency: Urgency;
  confidence: Confidence;
  estimatedUpside: string | null;
  estimatedDownside: string | null;
  estimatedCost: number | null;
  timeRequired: string | null;
  reversibility: Reversibility;
  capacityReqs: CapacityReqs | null;
  requiredVerification: string | null;
  candidateAction: string | null;
  staleDate: string;         // ISO YYYY-MM-DD — after which the signal is untrusted
  reasonCodes: string[];
}

/** Read-only context passed to every provider (deterministic given fixed values). */
export interface SignalContext {
  today: string;             // local date YYYY-MM-DD (America/New_York)
  timezone: string;          // e.g. "America/New_York"
  now: string;               // ISO timestamp (informational; providers stay date-deterministic)
  freshnessDays?: number;    // bounded look-back / default stale window
}

/** The consistent read-only provider interface (spec §3). No ranking/orchestration. */
export interface DailySignalProvider {
  domain: DailyDomain;
  getDailySignals(userId: number, ctx: SignalContext): Promise<DailySignal[]>;
}

/* ---------------------------------------------------- helpers ------------- */
export const DEFAULT_FRESHNESS_DAYS = 1;
export const isISODate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
export const isoAddDays = (iso: string, d: number) => new Date(Date.parse(iso) + d * 86400000).toISOString().slice(0, 10);
export const dayDiff = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);

/** Deterministic urgency for a dated item relative to `today` (reuses the 3-day
 * attention horizon convention from lib/briefing.ts). */
export function datedUrgency(effectiveDate: string | null, today: string): Urgency {
  if (!effectiveDate) return "low";
  const d = dayDiff(effectiveDate, today);
  if (d <= 0) return "high";        // overdue or due today
  if (d <= 3) return "medium";      // due soon (ATTENTION_HORIZON_DAYS)
  return "low";
}

/** Validate a signal against the contract. Returns a list of problems ([] = ok). */
export function validateSignal(s: DailySignal): string[] {
  const errs: string[] = [];
  const bad = (m: string) => errs.push(m);
  if (!s.key || typeof s.key !== "string") bad("key missing");
  if (!(DAILY_DOMAINS as readonly string[]).includes(s.domain)) bad(`bad domain: ${s.domain}`);
  else {
    if (!s.key.startsWith(`${s.domain}:`)) bad(`key must start with "${s.domain}:" → ${s.key}`);
    if (!(SIGNAL_TYPES[s.domain] as readonly string[]).includes(s.signalType)) bad(`signalType "${s.signalType}" not allowed for domain "${s.domain}"`);
  }
  if (!(SIGNAL_CLASSES as readonly string[]).includes(s.class)) bad(`bad class: ${s.class}`);
  if (!(URGENCIES as readonly string[]).includes(s.urgency)) bad(`bad urgency: ${s.urgency}`);
  if (!(CONFIDENCES as readonly string[]).includes(s.confidence)) bad(`bad confidence: ${s.confidence}`);
  if (!(REVERSIBILITIES as readonly string[]).includes(s.reversibility)) bad(`bad reversibility: ${s.reversibility}`);
  if (!s.title) bad("title missing");
  if (!s.summary) bad("summary missing");
  if (typeof s.evidence !== "string") bad("evidence must be a string");
  if (!Array.isArray(s.sourceRefs) || s.sourceRefs.length === 0) bad("sourceRefs required");
  else s.sourceRefs.forEach((r, i) => { if (!r || typeof r.service !== "string" || !r.service) bad(`sourceRefs[${i}].service missing`); });
  if (!isISODate(s.observedDate)) bad(`observedDate not ISO: ${s.observedDate}`);
  if (s.effectiveDate !== null && !isISODate(s.effectiveDate)) bad(`effectiveDate not ISO/null: ${s.effectiveDate}`);
  if (!isISODate(s.staleDate)) bad(`staleDate not ISO: ${s.staleDate}`);
  if (s.estimatedCost !== null && typeof s.estimatedCost !== "number") bad("estimatedCost must be number|null");
  if (!Array.isArray(s.reasonCodes)) bad("reasonCodes must be an array");
  return errs;
}

/** Convenience: validate a batch; returns { ok, errors } where errors are keyed. */
export function validateSignals(list: DailySignal[]): { ok: boolean; errors: { key: string; problems: string[] }[] } {
  const errors = list.map((s) => ({ key: s.key ?? "(nokey)", problems: validateSignal(s) })).filter((e) => e.problems.length > 0);
  return { ok: errors.length === 0, errors };
}
