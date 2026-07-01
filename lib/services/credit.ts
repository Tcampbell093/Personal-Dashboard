/* =============================================================================
 * Finance 1C.0A — manual credit profile + deterministic financial-health engine.
 *
 * ALL owner-entered + read-only. This module NEVER connects to a bureau or
 * Credit Karma, never scrapes, never files a dispute, never applies for credit,
 * never moves money, and never mutates bank data (transactions, categories,
 * rules, balances, movements, provider snapshots, cursors, bills, income,
 * transfers, evidence). Calculations are pure; the only writes are owner CRUD on
 * the six credit_* tables. No guaranteed score-impact claim is ever produced.
 * ===========================================================================*/

import { and, eq, isNull, desc, asc } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db } from "@/db";
import {
  creditScoreSnapshots, creditAccounts, creditCollections,
  creditLatePayments, creditInquiries, creditGoals,
} from "@/db/schema";
import { computeFinancialOutlook } from "@/lib/services/finances";
import { localToday } from "@/lib/time";

export class CreditError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.name = "CreditError"; this.status = status; }
}

/* ------------------------------------------------------- constants ------- */
export const SCORE_MIN = 250, SCORE_MAX = 900;
export const STALE_SCORE_DAYS = 45;
export const UTIL_TARGETS = [50, 30, 10] as const;
export const SCORE_SOURCES = ["experian", "equifax", "transunion", "credit_karma", "bank", "lender", "other"];
export const ACCOUNT_TYPES = ["credit_card", "secured_card", "auto_loan", "personal_loan", "student_loan", "mortgage", "retail_card", "other"];
export const ACCOUNT_STATUSES = ["open", "closed", "charged_off", "delinquent", "unknown"];
export const COLLECTION_STATUSES = ["reported", "disputed", "validated", "settled", "paid", "removed", "unknown"];
export const VALIDATION_STATUSES = ["not_requested", "requested", "received", "incomplete", "verified_by_owner"];
export const LATE_STATUSES = ["reported", "resolved", "disputed", "removed"];
export const INQUIRY_TYPES = ["hard", "soft"];
export const GOAL_TYPES = ["score_target", "utilization_target", "collection_resolution", "on_time_payment_streak", "debt_balance_target"];
export const GOAL_STATUSES = ["active", "achieved", "paused", "abandoned"];

const SOURCE_MIX_NOTE = "Scores from different bureaus and scoring models may differ. Compare trends within the same source when possible.";
const UTIL_EDU_NOTE = "Lower reported utilization is generally associated with healthier credit profiles, but score impact varies.";
const NO_GUARANTEE = "This is educational guidance, not a guaranteed score change.";

/* --------------------------------------------------------- helpers ------- */
const isUniqueViolation = (e: unknown) => typeof e === "object" && e != null && (e as { code?: string }).code === "23505";
const num = (s: string | null | undefined) => (s == null ? 0 : Number(s));
const money = (n: number) => `$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
const round2 = (n: number) => Math.round(n * 100) / 100;
const isISO = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const daysBetween = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
const addDaysISO = (iso: string, d: number) => new Date(Date.parse(iso) + d * 86400000).toISOString().slice(0, 10);
const monthsBetween = (a: string, b: string) => { const da = new Date(a), db_ = new Date(b); return (da.getUTCFullYear() - db_.getUTCFullYear()) * 12 + (da.getUTCMonth() - db_.getUTCMonth()); };

function reqStr(v: unknown, field: string, max = 200): string {
  if (typeof v !== "string" || !v.trim()) throw new CreditError(400, `${field} is required.`);
  if (v.length > max) throw new CreditError(400, `${field} is too long.`);
  return v.trim();
}
function optNum(v: unknown, field: string, { min, max, allowNull = true }: { min?: number; max?: number; allowNull?: boolean } = {}): number | null {
  if (v == null || v === "") { if (allowNull) return null; throw new CreditError(400, `${field} is required.`); }
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new CreditError(400, `${field} must be a number.`);
  if (min != null && n < min) throw new CreditError(400, `${field} is below the allowed minimum.`);
  if (max != null && n > max) throw new CreditError(400, `${field} exceeds the allowed maximum.`);
  return n;
}
const oneOf = (v: unknown, allowed: string[], field: string, dflt?: string): string => {
  if ((v == null || v === "") && dflt != null) return dflt;
  if (typeof v !== "string" || !allowed.includes(v)) throw new CreditError(400, `${field} must be one of: ${allowed.join(", ")}.`);
  return v;
};
const optDate = (v: unknown, field: string): string | null => { if (v == null || v === "") return null; if (!isISO(v)) throw new CreditError(400, `${field} must be a valid YYYY-MM-DD date.`); return v; };
const reqDate = (v: unknown, field: string): string => { if (!isISO(v)) throw new CreditError(400, `${field} must be a valid YYYY-MM-DD date.`); return v as string; };

/* ============================================================ CRUD ======= */
/* Score snapshots ------------------------------------------------------- */
export interface ScoreInput { score: unknown; source: unknown; bureau?: unknown; scoringModel?: unknown; asOfDate: unknown; notes?: unknown; }

export async function listScores(userId: number) {
  return db.select().from(creditScoreSnapshots)
    .where(and(eq(creditScoreSnapshots.userId, userId), isNull(creditScoreSnapshots.deletedAt)))
    .orderBy(desc(creditScoreSnapshots.asOfDate), desc(creditScoreSnapshots.id));
}
export async function createScore(userId: number, input: ScoreInput) {
  const score = optNum(input.score, "score", { min: SCORE_MIN, max: SCORE_MAX, allowNull: false })!;
  const source = oneOf(input.source, SCORE_SOURCES, "source");
  const asOfDate = reqDate(input.asOfDate, "asOfDate");
  const scoringModel = input.scoringModel == null || input.scoringModel === "" ? null : reqStr(input.scoringModel, "scoringModel", 60);
  const bureau = input.bureau == null || input.bureau === "" ? null : reqStr(input.bureau, "bureau", 40);
  const notes = input.notes == null || input.notes === "" ? null : String(input.notes).slice(0, 2000);
  // Idempotent against LIVE rows only, so a delete-then-re-add always yields a fresh
  // live row (a soft-deleted identical snapshot is ignored). The live-only partial
  // unique index is the concurrency backstop: a racing duplicate insert throws 23505,
  // which we resolve by returning the row the winner created.
  const liveMatch = () => db.select().from(creditScoreSnapshots)
    .where(and(eq(creditScoreSnapshots.userId, userId), eq(creditScoreSnapshots.source, source), scoringModel == null ? isNull(creditScoreSnapshots.scoringModel) : eq(creditScoreSnapshots.scoringModel, scoringModel), eq(creditScoreSnapshots.asOfDate, asOfDate), eq(creditScoreSnapshots.score, score), isNull(creditScoreSnapshots.deletedAt)))
    .limit(1);
  const [existing] = await liveMatch();
  if (existing) return existing; // idempotent — no silent overwrite
  try {
    const [row] = await db.insert(creditScoreSnapshots).values({ userId, score, source, bureau, scoringModel, asOfDate, notes }).returning();
    return row;
  } catch (e) {
    if (isUniqueViolation(e)) { const [row] = await liveMatch(); if (row) return row; }
    throw e;
  }
}
export async function updateScore(userId: number, id: number, input: Partial<ScoreInput>) {
  await ownOrThrow(creditScoreSnapshots, userId, id);
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.score !== undefined) patch.score = optNum(input.score, "score", { min: SCORE_MIN, max: SCORE_MAX, allowNull: false });
  if (input.source !== undefined) patch.source = oneOf(input.source, SCORE_SOURCES, "source");
  if (input.asOfDate !== undefined) patch.asOfDate = reqDate(input.asOfDate, "asOfDate");
  if (input.bureau !== undefined) patch.bureau = input.bureau === "" || input.bureau == null ? null : reqStr(input.bureau, "bureau", 40);
  if (input.scoringModel !== undefined) patch.scoringModel = input.scoringModel === "" || input.scoringModel == null ? null : reqStr(input.scoringModel, "scoringModel", 60);
  if (input.notes !== undefined) patch.notes = input.notes == null || input.notes === "" ? null : String(input.notes).slice(0, 2000);
  const [row] = await db.update(creditScoreSnapshots).set(patch).where(and(eq(creditScoreSnapshots.userId, userId), eq(creditScoreSnapshots.id, id))).returning();
  return row;
}
export async function deleteScore(userId: number, id: number) {
  await ownOrThrow(creditScoreSnapshots, userId, id);
  await db.update(creditScoreSnapshots).set({ deletedAt: new Date(), updatedAt: new Date() }).where(and(eq(creditScoreSnapshots.userId, userId), eq(creditScoreSnapshots.id, id)));
  return { ok: true as const };
}

/* Accounts -------------------------------------------------------------- */
export interface AccountInput { accountType: unknown; name: unknown; issuer?: unknown; status?: unknown; isRevolving?: unknown; creditLimit?: unknown; currentBalance?: unknown; minimumPayment?: unknown; interestRate?: unknown; openedDate?: unknown; closedDate?: unknown; statementDate?: unknown; paymentDueDate?: unknown; lastReportedDate?: unknown; isAuthorizedUser?: unknown; notes?: unknown; }
export async function listAccounts(userId: number) {
  return db.select().from(creditAccounts).where(and(eq(creditAccounts.userId, userId), isNull(creditAccounts.deletedAt))).orderBy(asc(creditAccounts.name), asc(creditAccounts.id));
}
function accountValues(input: AccountInput, partial = false) {
  const v: Record<string, unknown> = {};
  const has = (k: keyof AccountInput) => input[k] !== undefined;
  if (!partial || has("accountType")) v.accountType = oneOf(input.accountType, ACCOUNT_TYPES, "accountType");
  if (!partial || has("name")) v.name = reqStr(input.name, "name", 120);
  if (!partial || has("issuer")) v.issuer = input.issuer == null || input.issuer === "" ? null : reqStr(input.issuer, "issuer", 120);
  if (!partial || has("status")) v.status = oneOf(input.status, ACCOUNT_STATUSES, "status", "open");
  if (!partial || has("isRevolving")) v.isRevolving = Boolean(input.isRevolving);
  if (!partial || has("creditLimit")) { const l = optNum(input.creditLimit, "creditLimit", { min: 0 }); if (l != null && l <= 0) throw new CreditError(400, "creditLimit must be positive when set."); v.creditLimit = l == null ? null : String(round2(l)); }
  if (!partial || has("currentBalance")) { const b = optNum(input.currentBalance, "currentBalance", { min: 0, allowNull: partial }); v.currentBalance = b == null ? "0" : String(round2(b)); }
  if (!partial || has("minimumPayment")) { const m = optNum(input.minimumPayment, "minimumPayment", { min: 0 }); v.minimumPayment = m == null ? null : String(round2(m)); }
  if (!partial || has("interestRate")) { const r = optNum(input.interestRate, "interestRate", { min: 0, max: 100 }); v.interestRate = r == null ? null : String(round2(r)); }
  for (const d of ["openedDate", "closedDate", "statementDate", "paymentDueDate", "lastReportedDate"] as const) if (!partial || has(d)) v[d] = optDate(input[d], d);
  if (!partial || has("isAuthorizedUser")) v.isAuthorizedUser = Boolean(input.isAuthorizedUser);
  if (!partial || has("notes")) v.notes = input.notes == null || input.notes === "" ? null : String(input.notes).slice(0, 2000);
  return v;
}
export async function createAccount(userId: number, input: AccountInput) {
  const [row] = await db.insert(creditAccounts).values({ userId, ...accountValues(input) } as typeof creditAccounts.$inferInsert).returning();
  return row;
}
export async function updateAccount(userId: number, id: number, input: Partial<AccountInput>) {
  await ownOrThrow(creditAccounts, userId, id);
  const [row] = await db.update(creditAccounts).set({ ...accountValues(input as AccountInput, true), updatedAt: new Date() }).where(and(eq(creditAccounts.userId, userId), eq(creditAccounts.id, id))).returning();
  return row;
}
/** Prefer archive (status=closed) over destructive delete when referenced by late payments. */
export async function deleteAccount(userId: number, id: number) {
  await ownOrThrow(creditAccounts, userId, id);
  const [late] = await db.select({ id: creditLatePayments.id }).from(creditLatePayments).where(and(eq(creditLatePayments.creditAccountId, id), isNull(creditLatePayments.deletedAt))).limit(1);
  if (late) { const [row] = await db.update(creditAccounts).set({ status: "closed", closedDate: localToday(), updatedAt: new Date() }).where(and(eq(creditAccounts.userId, userId), eq(creditAccounts.id, id))).returning(); return { archived: true as const, row }; }
  await db.update(creditAccounts).set({ deletedAt: new Date(), updatedAt: new Date() }).where(and(eq(creditAccounts.userId, userId), eq(creditAccounts.id, id)));
  return { archived: false as const };
}

/* Collections ----------------------------------------------------------- */
export interface CollectionInput { collectorName: unknown; originalCreditor?: unknown; reportedBalance?: unknown; status?: unknown; dateOpened?: unknown; dateReported?: unknown; lastUpdatedDate?: unknown; validationStatus?: unknown; settlementOffer?: unknown; payForDeleteRequested?: unknown; notes?: unknown; }
export async function listCollections(userId: number) {
  return db.select().from(creditCollections).where(and(eq(creditCollections.userId, userId), isNull(creditCollections.deletedAt))).orderBy(asc(creditCollections.dateReported), asc(creditCollections.id));
}
function collectionValues(input: CollectionInput, partial = false) {
  const v: Record<string, unknown> = {}; const has = (k: keyof CollectionInput) => input[k] !== undefined;
  if (!partial || has("collectorName")) v.collectorName = reqStr(input.collectorName, "collectorName", 160);
  if (!partial || has("originalCreditor")) v.originalCreditor = input.originalCreditor == null || input.originalCreditor === "" ? null : reqStr(input.originalCreditor, "originalCreditor", 160);
  if (!partial || has("reportedBalance")) { const b = optNum(input.reportedBalance, "reportedBalance", { min: 0, allowNull: partial }); v.reportedBalance = b == null ? "0" : String(round2(b)); }
  if (!partial || has("status")) v.status = oneOf(input.status, COLLECTION_STATUSES, "status", "reported");
  if (!partial || has("validationStatus")) v.validationStatus = oneOf(input.validationStatus, VALIDATION_STATUSES, "validationStatus", "not_requested");
  if (!partial || has("settlementOffer")) { const s = optNum(input.settlementOffer, "settlementOffer", { min: 0 }); v.settlementOffer = s == null ? null : String(round2(s)); }
  if (!partial || has("payForDeleteRequested")) v.payForDeleteRequested = Boolean(input.payForDeleteRequested);
  for (const d of ["dateOpened", "dateReported", "lastUpdatedDate"] as const) if (!partial || has(d)) v[d] = optDate(input[d], d);
  if (!partial || has("notes")) v.notes = input.notes == null || input.notes === "" ? null : String(input.notes).slice(0, 2000);
  return v;
}
export async function createCollection(userId: number, input: CollectionInput) {
  const [row] = await db.insert(creditCollections).values({ userId, ...collectionValues(input) } as typeof creditCollections.$inferInsert).returning();
  return row;
}
export async function updateCollection(userId: number, id: number, input: Partial<CollectionInput>) {
  await ownOrThrow(creditCollections, userId, id);
  const [row] = await db.update(creditCollections).set({ ...collectionValues(input as CollectionInput, true), updatedAt: new Date() }).where(and(eq(creditCollections.userId, userId), eq(creditCollections.id, id))).returning();
  return row;
}

/* Inquiries ------------------------------------------------------------- */
export interface InquiryInput { creditorName: unknown; inquiryDate: unknown; bureau?: unknown; inquiryType?: unknown; purpose?: unknown; notes?: unknown; }
export async function listInquiries(userId: number) {
  return db.select().from(creditInquiries).where(and(eq(creditInquiries.userId, userId), isNull(creditInquiries.deletedAt))).orderBy(desc(creditInquiries.inquiryDate), desc(creditInquiries.id));
}
export async function createInquiry(userId: number, input: InquiryInput) {
  const creditorName = reqStr(input.creditorName, "creditorName", 160);
  const inquiryDate = reqDate(input.inquiryDate, "inquiryDate");
  const inquiryType = oneOf(input.inquiryType, INQUIRY_TYPES, "inquiryType", "hard");
  const bureau = input.bureau == null || input.bureau === "" ? null : reqStr(input.bureau, "bureau", 40);
  const purpose = input.purpose == null || input.purpose === "" ? null : reqStr(input.purpose, "purpose", 120);
  const notes = input.notes == null || input.notes === "" ? null : String(input.notes).slice(0, 2000);
  // Same live-only idempotency as scores — a soft-deleted identical inquiry never
  // blocks a re-entry; the partial unique index guards concurrent duplicates.
  const liveMatch = () => db.select().from(creditInquiries).where(and(eq(creditInquiries.userId, userId), eq(creditInquiries.creditorName, creditorName), eq(creditInquiries.inquiryDate, inquiryDate), eq(creditInquiries.inquiryType, inquiryType), isNull(creditInquiries.deletedAt))).limit(1);
  const [existing] = await liveMatch();
  if (existing) return existing;
  try {
    const [row] = await db.insert(creditInquiries).values({ userId, creditorName, inquiryDate, inquiryType, bureau, purpose, notes }).returning();
    return row;
  } catch (e) {
    if (isUniqueViolation(e)) { const [row] = await liveMatch(); if (row) return row; }
    throw e;
  }
}
export async function updateInquiry(userId: number, id: number, input: Partial<InquiryInput>) {
  await ownOrThrow(creditInquiries, userId, id);
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.creditorName !== undefined) patch.creditorName = reqStr(input.creditorName, "creditorName", 160);
  if (input.inquiryDate !== undefined) patch.inquiryDate = reqDate(input.inquiryDate, "inquiryDate");
  if (input.inquiryType !== undefined) patch.inquiryType = oneOf(input.inquiryType, INQUIRY_TYPES, "inquiryType");
  if (input.bureau !== undefined) patch.bureau = input.bureau === "" || input.bureau == null ? null : reqStr(input.bureau, "bureau", 40);
  if (input.purpose !== undefined) patch.purpose = input.purpose === "" || input.purpose == null ? null : reqStr(input.purpose, "purpose", 120);
  if (input.notes !== undefined) patch.notes = input.notes == null || input.notes === "" ? null : String(input.notes).slice(0, 2000);
  const [row] = await db.update(creditInquiries).set(patch).where(and(eq(creditInquiries.userId, userId), eq(creditInquiries.id, id))).returning();
  return row;
}

/* Late payments --------------------------------------------------------- */
export interface LateInput { creditAccountId: unknown; daysLate: unknown; reportedDate: unknown; amountPastDue?: unknown; status?: unknown; notes?: unknown; }
export async function listLatePayments(userId: number) {
  return db.select().from(creditLatePayments).where(and(eq(creditLatePayments.userId, userId), isNull(creditLatePayments.deletedAt))).orderBy(desc(creditLatePayments.reportedDate), desc(creditLatePayments.id));
}
export async function createLatePayment(userId: number, input: LateInput) {
  const creditAccountId = optNum(input.creditAccountId, "creditAccountId", { min: 1, allowNull: false })!;
  await ownOrThrow(creditAccounts, userId, creditAccountId); // link must be an owned account
  const daysLate = optNum(input.daysLate, "daysLate", { min: 1, max: 3650, allowNull: false })!;
  const reportedDate = reqDate(input.reportedDate, "reportedDate");
  const status = oneOf(input.status, LATE_STATUSES, "status", "reported");
  const amt = optNum(input.amountPastDue, "amountPastDue", { min: 0 });
  const notes = input.notes == null || input.notes === "" ? null : String(input.notes).slice(0, 2000);
  const [row] = await db.insert(creditLatePayments).values({ userId, creditAccountId, daysLate, reportedDate, status, amountPastDue: amt == null ? null : String(round2(amt)), notes }).returning();
  return row;
}
export async function updateLatePayment(userId: number, id: number, input: Partial<LateInput>) {
  await ownOrThrow(creditLatePayments, userId, id);
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.daysLate !== undefined) patch.daysLate = optNum(input.daysLate, "daysLate", { min: 1, max: 3650, allowNull: false });
  if (input.reportedDate !== undefined) patch.reportedDate = reqDate(input.reportedDate, "reportedDate");
  if (input.status !== undefined) patch.status = oneOf(input.status, LATE_STATUSES, "status");
  if (input.amountPastDue !== undefined) { const a = optNum(input.amountPastDue, "amountPastDue", { min: 0 }); patch.amountPastDue = a == null ? null : String(round2(a)); }
  if (input.notes !== undefined) patch.notes = input.notes == null || input.notes === "" ? null : String(input.notes).slice(0, 2000);
  const [row] = await db.update(creditLatePayments).set(patch).where(and(eq(creditLatePayments.userId, userId), eq(creditLatePayments.id, id))).returning();
  return row;
}

/* Goals ----------------------------------------------------------------- */
export interface GoalInput { goalType: unknown; targetValue: unknown; targetDate?: unknown; status?: unknown; priority?: unknown; notes?: unknown; }
export async function listGoals(userId: number) {
  return db.select().from(creditGoals).where(and(eq(creditGoals.userId, userId), isNull(creditGoals.deletedAt))).orderBy(asc(creditGoals.id));
}
function validateGoalTarget(goalType: string, target: number) {
  if (goalType === "score_target" && (target < SCORE_MIN || target > SCORE_MAX)) throw new CreditError(400, "score_target must be a valid score.");
  if (goalType === "utilization_target" && (target < 0 || target > 100)) throw new CreditError(400, "utilization_target must be a percentage 0–100.");
  if ((goalType === "collection_resolution" || goalType === "on_time_payment_streak" || goalType === "debt_balance_target") && target < 0) throw new CreditError(400, "targetValue must be non-negative.");
}
export async function createGoal(userId: number, input: GoalInput) {
  const goalType = oneOf(input.goalType, GOAL_TYPES, "goalType");
  const targetValue = optNum(input.targetValue, "targetValue", { allowNull: false })!;
  validateGoalTarget(goalType, targetValue);
  const status = oneOf(input.status, GOAL_STATUSES, "status", "active");
  const priority = oneOf(input.priority, ["low", "medium", "high"], "priority", "medium");
  const targetDate = optDate(input.targetDate, "targetDate");
  const notes = input.notes == null || input.notes === "" ? null : String(input.notes).slice(0, 2000);
  const [row] = await db.insert(creditGoals).values({ userId, goalType, targetValue: String(round2(targetValue)), targetDate, status, priority, notes }).returning();
  return row;
}
export async function updateGoal(userId: number, id: number, input: Partial<GoalInput>) {
  const existing = await ownOrThrow(creditGoals, userId, id);
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  const goalType = input.goalType !== undefined ? oneOf(input.goalType, GOAL_TYPES, "goalType") : String(existing.goalType);
  if (input.goalType !== undefined) patch.goalType = goalType;
  // Resolve the EFFECTIVE target (new value if provided, else the existing one) and
  // validate it against the EFFECTIVE goal type whenever either changes — otherwise
  // retyping a score target of 700 as a utilization target would slip through invalid.
  const targetChanged = input.targetValue !== undefined;
  const typeChanged = input.goalType !== undefined;
  if (targetChanged || typeChanged) {
    const effectiveTarget = targetChanged ? optNum(input.targetValue, "targetValue", { allowNull: false })! : Number(existing.targetValue);
    validateGoalTarget(goalType, effectiveTarget);
    if (targetChanged) patch.targetValue = String(round2(effectiveTarget));
  }
  if (input.status !== undefined) patch.status = oneOf(input.status, GOAL_STATUSES, "status");
  if (input.priority !== undefined) patch.priority = oneOf(input.priority, ["low", "medium", "high"], "priority");
  if (input.targetDate !== undefined) patch.targetDate = optDate(input.targetDate, "targetDate");
  if (input.notes !== undefined) patch.notes = input.notes == null || input.notes === "" ? null : String(input.notes).slice(0, 2000);
  const [row] = await db.update(creditGoals).set(patch).where(and(eq(creditGoals.userId, userId), eq(creditGoals.id, id))).returning();
  return row;
}

/* Ownership guard: reject foreign-owner or missing rows (no existence leak). */
type OwnedTable = typeof creditScoreSnapshots | typeof creditAccounts | typeof creditCollections | typeof creditLatePayments | typeof creditInquiries | typeof creditGoals;
async function ownOrThrow(table: OwnedTable, userId: number, id: number): Promise<Record<string, unknown>> {
  if (!Number.isInteger(id) || id <= 0) throw new CreditError(400, "Invalid id.");
  const t = table as unknown as { userId: PgColumn; id: PgColumn; deletedAt: PgColumn };
  const [row] = await db.select().from(table as typeof creditScoreSnapshots).where(and(eq(t.userId, userId), eq(t.id, id), isNull(t.deletedAt))).limit(1);
  if (!row) throw new CreditError(404, "Not found.");
  return row as Record<string, unknown>;
}

/* ==================================================== calculations ======= */
export type Health = "good" | "attention" | "insufficient";
type Conf = "high" | "medium" | "low";

export interface UtilizationView {
  aggregatePct: number | null; totalBalance: number; totalLimit: number;
  perAccount: { id: number; name: string; utilizationPct: number; balance: number; limit: number; isAuthorizedUser: boolean }[];
  toReach: { threshold: number; amount: number }[];
  missingLimitCount: number; authorizedUserCount: number; excludedInvalidCount: number; note: string;
}
export function computeUtilization(accounts: Awaited<ReturnType<typeof listAccounts>>): UtilizationView {
  const openRevolving = accounts.filter((a) => a.isRevolving && a.status === "open");
  const eligible = openRevolving.filter((a) => a.creditLimit != null && num(a.creditLimit) > 0 && num(a.currentBalance) >= 0);
  const missingLimitCount = openRevolving.filter((a) => a.creditLimit == null || num(a.creditLimit) <= 0).length;
  const excludedInvalidCount = openRevolving.filter((a) => num(a.currentBalance) < 0).length;
  const totalBalance = round2(eligible.reduce((s, a) => s + num(a.currentBalance), 0));
  const totalLimit = round2(eligible.reduce((s, a) => s + num(a.creditLimit), 0));
  const aggregatePct = totalLimit > 0 ? round2((totalBalance / totalLimit) * 100) : null;
  const perAccount = eligible.map((a) => ({ id: a.id, name: a.name, balance: round2(num(a.currentBalance)), limit: round2(num(a.creditLimit)), utilizationPct: round2((num(a.currentBalance) / num(a.creditLimit)) * 100), isAuthorizedUser: a.isAuthorizedUser }));
  const toReach = UTIL_TARGETS.map((threshold) => ({ threshold, amount: totalLimit > 0 ? Math.max(0, round2(totalBalance - (threshold / 100) * totalLimit)) : 0 }));
  return { aggregatePct, totalBalance, totalLimit, perAccount, toReach, missingLimitCount, authorizedUserCount: eligible.filter((a) => a.isAuthorizedUser).length, excludedInvalidCount, note: UTIL_EDU_NOTE };
}

export interface HistorySummary { oldestOpenDate: string | null; averageOpenAgeMonths: number | null; openRevolvingCount: number; installmentCount: number; derogatoryCount: number; latePaymentCount: number; recentHardInquiryCount: number; totalOpenAccounts: number; incomplete: boolean; }
export function computeHistory(accounts: Awaited<ReturnType<typeof listAccounts>>, lates: Awaited<ReturnType<typeof listLatePayments>>, inquiries: Awaited<ReturnType<typeof listInquiries>>, today: string): HistorySummary {
  const open = accounts.filter((a) => a.status === "open");
  const opened = open.filter((a) => a.openedDate).map((a) => a.openedDate!) as string[];
  const oldestOpenDate = opened.length ? opened.reduce((m, d) => (d < m ? d : m)) : null;
  const averageOpenAgeMonths = opened.length ? Math.round(opened.reduce((s, d) => s + monthsBetween(today, d), 0) / opened.length) : null;
  const recentHardInquiryCount = inquiries.filter((i) => i.inquiryType === "hard" && daysBetween(today, i.inquiryDate) <= 365).length;
  return {
    oldestOpenDate, averageOpenAgeMonths,
    openRevolvingCount: open.filter((a) => a.isRevolving).length,
    installmentCount: open.filter((a) => !a.isRevolving).length,
    derogatoryCount: accounts.filter((a) => a.status === "charged_off" || a.status === "delinquent").length,
    latePaymentCount: lates.length,
    recentHardInquiryCount, totalOpenAccounts: open.length,
    incomplete: open.length === 0 || opened.length < open.length,
  };
}

export interface CollectionsSummary { activeCount: number; activeBalance: number; smallestActiveBalance: number | null; oldestActiveDate: string | null; unresolvedCount: number; reviewCount: number; }
const COLLECTION_ACTIVE = (s: string) => !["removed", "paid", "settled"].includes(s);
export function computeCollections(collections: Awaited<ReturnType<typeof listCollections>>): CollectionsSummary {
  const active = collections.filter((c) => COLLECTION_ACTIVE(c.status));
  const balances = active.map((c) => num(c.reportedBalance));
  const dates = active.map((c) => c.dateOpened ?? c.dateReported).filter(Boolean) as string[];
  return {
    activeCount: active.length,
    activeBalance: round2(balances.reduce((s, b) => s + b, 0)),
    smallestActiveBalance: balances.length ? round2(Math.min(...balances)) : null,
    oldestActiveDate: dates.length ? dates.reduce((m, d) => (d < m ? d : m)) : null,
    unresolvedCount: active.filter((c) => c.validationStatus !== "verified_by_owner").length,
    reviewCount: active.filter((c) => ["not_requested", "requested", "incomplete"].includes(c.validationStatus)).length,
  };
}

export interface InquirySummary { hardCount: number; softCount: number; recentHardCount: number; }
export function computeInquiries(inquiries: Awaited<ReturnType<typeof listInquiries>>, today: string): InquirySummary {
  return { hardCount: inquiries.filter((i) => i.inquiryType === "hard").length, softCount: inquiries.filter((i) => i.inquiryType === "soft").length, recentHardCount: inquiries.filter((i) => i.inquiryType === "hard" && daysBetween(today, i.inquiryDate) <= 180).length };
}

export interface ScoreTrend { source: string; scoringModel: string | null; latest: number; latestDate: string; prior: number | null; priorDate: string | null; change: number | null; }
export function computeScoreTrends(scores: Awaited<ReturnType<typeof listScores>>): { trends: ScoreTrend[]; multiSourceWarning: string | null } {
  const bySource = new Map<string, typeof scores>();
  for (const s of scores) { const k = `${s.source}|${s.scoringModel ?? ""}`; (bySource.get(k) ?? bySource.set(k, []).get(k)!).push(s); }
  const trends: ScoreTrend[] = [];
  for (const [, list] of bySource) {
    const sorted = [...list].sort((a, b) => (a.asOfDate < b.asOfDate ? 1 : a.asOfDate > b.asOfDate ? -1 : b.id - a.id)); // newest first
    const latest = sorted[0], prior = sorted[1] ?? null;
    trends.push({ source: latest.source, scoringModel: latest.scoringModel, latest: latest.score, latestDate: latest.asOfDate, prior: prior?.score ?? null, priorDate: prior?.asOfDate ?? null, change: prior ? latest.score - prior.score : null });
  }
  trends.sort((a, b) => (a.latestDate < b.latestDate ? 1 : -1));
  const distinctSources = new Set(scores.map((s) => s.source));
  return { trends, multiSourceWarning: distinctSources.size > 1 ? SOURCE_MIX_NOTE : null };
}

/* ---- cash-flow context (best-effort; never fails the credit view) ------- */
export interface CashFlowContext { available: number | null; nextPaydayDate: string | null; billsBeforePayday: number; ok: boolean; }
export async function cashFlowContext(userId: number): Promise<CashFlowContext> {
  try {
    const o = await computeFinancialOutlook(userId);
    return { available: round2(o.estimatedRemaining), nextPaydayDate: o.nextPaydayDate, billsBeforePayday: round2(o.billsDueBeforePayday), ok: true };
  } catch { return { available: null, nextPaydayDate: null, billsBeforePayday: 0, ok: false }; }
}

/* ==================================================== observations ======= */
export interface CreditObservation { key: string; type: string; title: string; summary: string; evidence: string; confidence: Conf; source: string | null; limitation: string; asOfDate: string | null; reasonCodes: string[]; }

/* ==================================================== action cards ======= */
export interface CreditActionCard {
  key: string; title: string; observation: string; why: string; nextStep: string;
  estimatedCost: number | null; timing: string; tradeoff: string; verificationNeeded: string; confidence: Conf;
  // Personal Advantage Engine output shape (stable):
  domain: "credit"; actionType: string; urgency: "low" | "medium" | "high"; estimatedUpside: string;
  timeRequired: string; riskLevel: "low" | "medium" | "high"; evidence: string; professionalVerificationRecommended: boolean;
}

export interface HealthSummary {
  sections: { key: string; label: string; status: Health; detail: string }[];
  overall: "improving" | "stable" | "attention" | "insufficient"; overallReasons: string[];
}

export interface CreditOverview {
  scores: Awaited<ReturnType<typeof listScores>>;
  trends: ScoreTrend[]; multiSourceWarning: string | null;
  accounts: Awaited<ReturnType<typeof listAccounts>>;
  utilization: UtilizationView;
  collections: Awaited<ReturnType<typeof listCollections>>; collectionsSummary: CollectionsSummary;
  inquiries: Awaited<ReturnType<typeof listInquiries>>; inquirySummary: InquirySummary;
  latePayments: Awaited<ReturnType<typeof listLatePayments>>; latePaymentCount: number;
  goals: Awaited<ReturnType<typeof listGoals>>; goalProgress: { id: number; goalType: string; targetValue: number; currentValue: number | null; progressPct: number | null; status: string; onTrack: boolean | null }[];
  history: HistorySummary;
  observations: CreditObservation[]; actions: CreditActionCard[]; health: HealthSummary;
  cashFlow: CashFlowContext; dataQuality: string[]; staleScore: boolean; disclaimer: string;
}

function goalCurrentValue(goalType: string, ctx: { util: UtilizationView; latestScore: number | null; collections: CollectionsSummary; accounts: Awaited<ReturnType<typeof listAccounts>>; lates: Awaited<ReturnType<typeof listLatePayments>> }): number | null {
  switch (goalType) {
    case "score_target": return ctx.latestScore;
    case "utilization_target": return ctx.util.aggregatePct;
    case "collection_resolution": return ctx.collections.activeCount;
    case "debt_balance_target": return round2(ctx.accounts.filter((a) => a.status === "open").reduce((s, a) => s + num(a.currentBalance), 0));
    case "on_time_payment_streak": return ctx.lates.filter((l) => l.status === "reported").length === 0 ? 1 : 0;
    default: return null;
  }
}

export async function computeCreditOverview(userId: number, opts: { now?: string } = {}): Promise<CreditOverview> {
  const today = opts.now ?? localToday();
  const [scores, accounts, collections, inquiries, lates, goals] = await Promise.all([
    listScores(userId), listAccounts(userId), listCollections(userId), listInquiries(userId), listLatePayments(userId), listGoals(userId),
  ]);
  const utilization = computeUtilization(accounts);
  const { trends, multiSourceWarning } = computeScoreTrends(scores);
  const collectionsSummary = computeCollections(collections);
  const inquirySummary = computeInquiries(inquiries, today);
  const history = computeHistory(accounts, lates, inquiries, today);
  const cashFlow = await cashFlowContext(userId);
  const latest = scores[0] ?? null;
  const latestScore = latest?.score ?? null;
  const staleScore = latest ? daysBetween(today, latest.asOfDate) > STALE_SCORE_DAYS : false;

  const goalProgress = goals.map((g) => {
    const target = num(g.targetValue);
    const current = goalCurrentValue(g.goalType, { util: utilization, latestScore, collections: collectionsSummary, accounts, lates });
    let progressPct: number | null = null, onTrack: boolean | null = null;
    if (current != null) {
      if (g.goalType === "utilization_target" || g.goalType === "collection_resolution" || g.goalType === "debt_balance_target") { onTrack = current <= target; progressPct = target > 0 ? round2(Math.max(0, Math.min(100, (1 - Math.min(current, target * 2) / (target * 2 || 1)) * 100))) : (current <= target ? 100 : 0); }
      else { onTrack = current >= target; progressPct = target > 0 ? round2(Math.max(0, Math.min(100, (current / target) * 100))) : null; }
    }
    return { id: g.id, goalType: g.goalType, targetValue: target, currentValue: current, progressPct, status: g.status, onTrack };
  });

  const observations = buildObservations({ today, trends, utilization, accounts, collections, collectionsSummary, inquirySummary, history, latest, staleScore, goalProgress, cashFlow, multiSourceWarning });
  const actions = buildActions({ today, utilization, collections, collectionsSummary, inquirySummary, accounts, goals, latest, staleScore, cashFlow, history });
  const health = buildHealth({ scores, accounts, utilization, collectionsSummary, history, lates, goalProgress, cashFlow, trends, staleScore });

  const dataQuality: string[] = [];
  if (!scores.length) dataQuality.push("No score snapshot entered yet — add one to enable trend and health guidance.");
  if (utilization.missingLimitCount > 0) dataQuality.push(`${utilization.missingLimitCount} revolving account(s) are missing a credit limit — utilization is incomplete until you add them.`);
  if (staleScore) dataQuality.push("Your most recent score is over 45 days old — consider updating it.");
  if (history.incomplete) dataQuality.push("Some accounts are missing an opened date — credit-age figures are partial.");

  return {
    scores, trends, multiSourceWarning, accounts, utilization, collections, collectionsSummary,
    inquiries, inquirySummary, latePayments: lates, latePaymentCount: lates.length, goals, goalProgress,
    history, observations, actions, health, cashFlow, dataQuality, staleScore,
    disclaimer: "This credit information is manually entered and may become outdated. Xanther does not connect to a credit bureau or Credit Karma and gives educational guidance only, not financial, legal, or credit-repair advice.",
  };
}

/* ------------------------------------------------ observation builder ---- */
function buildObservations(x: {
  today: string; trends: ScoreTrend[]; utilization: UtilizationView; accounts: Awaited<ReturnType<typeof listAccounts>>;
  collections: Awaited<ReturnType<typeof listCollections>>; collectionsSummary: CollectionsSummary; inquirySummary: InquirySummary;
  history: HistorySummary; latest: Awaited<ReturnType<typeof listScores>>[number] | null; staleScore: boolean;
  goalProgress: CreditOverview["goalProgress"]; cashFlow: CashFlowContext; multiSourceWarning: string | null;
}): CreditObservation[] {
  const o: CreditObservation[] = [];
  const push = (v: CreditObservation) => o.push(v);
  // score_change (same source)
  const t = x.trends.find((tr) => tr.change != null);
  if (t && t.change != null) {
    const up = t.change > 0;
    push({ key: `score_change:${t.source}:${t.latestDate}`, type: "score_change", title: up ? `Reported score up ${t.change} points` : t.change === 0 ? "Reported score unchanged" : `Reported score down ${Math.abs(t.change)} points`,
      summary: up ? `Your ${t.source} score increased by ${t.change} points since your last update from the same source.` : t.change === 0 ? `Your ${t.source} score is unchanged since your last same-source update.` : `Your ${t.source} score decreased by ${Math.abs(t.change)} points versus your last same-source update — scores move for many reasons and one change is not conclusive.`,
      evidence: `${t.source}${t.scoringModel ? ` (${t.scoringModel})` : ""}: ${t.prior} on ${t.priorDate} → ${t.latest} on ${t.latestDate}`, confidence: "high", source: t.source, limitation: `Only compared within the same source. ${NO_GUARANTEE}`, asOfDate: t.latestDate, reasonCodes: ["same_source_trend"] });
  }
  // utilization_high / progress
  if (x.utilization.aggregatePct != null) {
    if (x.utilization.aggregatePct >= 30) push({ key: `utilization_high:${x.today}`, type: "utilization_high", title: `Revolving utilization ~${Math.round(x.utilization.aggregatePct)}%`, summary: `Your revolving utilization is approximately ${Math.round(x.utilization.aggregatePct)}%. ${UTIL_EDU_NOTE}`, evidence: `${money(x.utilization.totalBalance)} balance ÷ ${money(x.utilization.totalLimit)} limit`, confidence: "high", source: null, limitation: `Utilization is one of several factors. ${NO_GUARANTEE}`, asOfDate: x.today, reasonCodes: ["aggregate_utilization"] });
    else push({ key: `utilization_progress:${x.today}`, type: "utilization_progress", title: `Revolving utilization ~${Math.round(x.utilization.aggregatePct)}%`, summary: `Your revolving utilization is approximately ${Math.round(x.utilization.aggregatePct)}%, which is in a generally healthier range. ${UTIL_EDU_NOTE}`, evidence: `${money(x.utilization.totalBalance)} balance ÷ ${money(x.utilization.totalLimit)} limit`, confidence: "high", source: null, limitation: NO_GUARANTEE, asOfDate: x.today, reasonCodes: ["aggregate_utilization"] });
  }
  // payment_due_soon / overdue
  for (const a of x.accounts.filter((a) => a.status === "open" && a.paymentDueDate)) {
    const d = daysBetween(a.paymentDueDate!, x.today);
    if (d < 0 && num(a.currentBalance) > 0) push({ key: `payment_overdue:${a.id}`, type: "payment_overdue", title: `${a.name} payment appears overdue`, summary: `Your manual record shows a ${a.name} payment due date of ${a.paymentDueDate}, which is in the past. Confirm whether it was paid.`, evidence: `due ${a.paymentDueDate}, balance ${money(num(a.currentBalance))}`, confidence: "medium", source: null, limitation: "Based on your manual entry — Xanther does not verify payment status with the lender.", asOfDate: x.today, reasonCodes: ["manual_due_date_past"] });
    else if (d >= 0 && d <= 14) push({ key: `payment_due_soon:${a.id}`, type: "payment_due_soon", title: `${a.name} payment due soon`, summary: `Your ${a.name} payment is due on ${a.paymentDueDate}${x.cashFlow.nextPaydayDate && a.paymentDueDate! < x.cashFlow.nextPaydayDate ? ", which is before your next expected paycheck" : ""}.`, evidence: `due ${a.paymentDueDate}${a.minimumPayment ? `, min ${money(num(a.minimumPayment))}` : ""}`, confidence: "high", source: null, limitation: "Based on your manual entry.", asOfDate: x.today, reasonCodes: ["upcoming_due_date"] });
  }
  // collection_unverified / resolution progress
  const unverified = x.collections.filter((c) => COLLECTION_ACTIVE(c.status) && ["not_requested", "requested", "incomplete"].includes(c.validationStatus));
  if (unverified.length) { const c = unverified[0]; push({ key: `collection_unverified:${c.id}`, type: "collection_unverified", title: `Unverified collection: ${c.collectorName}`, summary: `A collection from ${c.collectorName} (${money(num(c.reportedBalance))}) has not been validated. Verify the debt and obtain terms in writing before paying.`, evidence: `balance ${money(num(c.reportedBalance))}, validation ${c.validationStatus}`, confidence: "high", source: null, limitation: "Xanther does not confirm whether this debt is valid or yours.", asOfDate: x.today, reasonCodes: ["collection_not_validated"] }); }
  const resolved = x.collections.filter((c) => ["settled", "paid"].includes(c.status) || c.validationStatus === "verified_by_owner");
  if (resolved.length) push({ key: `collection_resolution_progress:${x.today}`, type: "collection_resolution_progress", title: `Progress on ${resolved.length} collection(s)`, summary: `You have recorded progress (validated, settled, or paid) on ${resolved.length} collection(s).`, evidence: `${resolved.length} collection(s) advanced`, confidence: "medium", source: null, limitation: `Recording a collection as paid does not promise a score change. ${NO_GUARANTEE}`, asOfDate: x.today, reasonCodes: ["collection_progress"] });
  // recent_hard_inquiries
  if (x.inquirySummary.recentHardCount >= 2) push({ key: `recent_hard_inquiries:${x.today}`, type: "recent_hard_inquiries", title: `${x.inquirySummary.recentHardCount} recent hard inquiries`, summary: `You recorded ${x.inquirySummary.recentHardCount} hard inquiries in the last 6 months. Consider avoiding unnecessary new applications while these remain recent.`, evidence: `${x.inquirySummary.recentHardCount} hard inquiries ≤180 days`, confidence: "high", source: null, limitation: `Only hard inquiries are counted. ${NO_GUARANTEE}`, asOfDate: x.today, reasonCodes: ["recent_hard_inquiries"] });
  // thin_or_incomplete_profile
  if (x.history.totalOpenAccounts < 2 || x.history.incomplete || x.utilization.missingLimitCount > 0) push({ key: `thin_or_incomplete_profile:${x.today}`, type: "thin_or_incomplete_profile", title: "Credit profile is thin or incomplete", summary: `Some credit data is missing or limited (${x.history.totalOpenAccounts} open account(s)${x.utilization.missingLimitCount ? `, ${x.utilization.missingLimitCount} without a limit` : ""}). Guidance improves as you add more detail.`, evidence: `open accounts ${x.history.totalOpenAccounts}, missing limits ${x.utilization.missingLimitCount}`, confidence: "medium", source: null, limitation: "This reflects only what you have entered.", asOfDate: x.today, reasonCodes: ["incomplete_profile"] });
  // goal_progress
  for (const g of x.goalProgress.filter((g) => g.status === "active" && g.progressPct != null)) push({ key: `goal_progress:${g.id}`, type: "goal_progress", title: `Goal progress: ${g.goalType.replace(/_/g, " ")}`, summary: `Your ${g.goalType.replace(/_/g, " ")} goal is about ${Math.round(g.progressPct!)}% toward target (${g.targetValue}).`, evidence: `current ${g.currentValue ?? "n/a"}, target ${g.targetValue}`, confidence: "medium", source: null, limitation: NO_GUARANTEE, asOfDate: x.today, reasonCodes: ["goal_progress"] });
  // cash_flow_conflict (payment before payday and buffer tight)
  if (x.cashFlow.ok && x.cashFlow.nextPaydayDate) {
    const due = x.accounts.find((a) => a.status === "open" && a.paymentDueDate && a.paymentDueDate <= x.cashFlow.nextPaydayDate! && a.paymentDueDate >= x.today && num(a.minimumPayment) > 0 && x.cashFlow.available != null && num(a.minimumPayment) > x.cashFlow.available);
    if (due) push({ key: `cash_flow_conflict:${due.id}`, type: "cash_flow_conflict", title: "A credit payment may strain cash flow", summary: `Your ${due.name} minimum of ${money(num(due.minimumPayment))} is due before your next expected paycheck, and your estimated available cash after upcoming bills is ${money(x.cashFlow.available!)}. Prioritize essential bills first.`, evidence: `min ${money(num(due.minimumPayment))} due ${due.paymentDueDate}, est. available ${money(x.cashFlow.available!)}`, confidence: "medium", source: null, limitation: "Cash-flow context is estimated from your manual finance data and excludes essential-bill money.", asOfDate: x.today, reasonCodes: ["cash_flow_tight"] });
  }
  // data_update_needed
  if (x.staleScore && x.latest) push({ key: `data_update_needed:${x.today}`, type: "data_update_needed", title: "Score data is getting stale", summary: `Your most recent score (${x.latest.source}, ${x.latest.asOfDate}) is over ${STALE_SCORE_DAYS} days old. Update it for more accurate guidance.`, evidence: `latest ${x.latest.asOfDate}`, confidence: "high", source: x.latest.source, limitation: "Xanther does not monitor bureaus — updates are manual.", asOfDate: x.latest.asOfDate, reasonCodes: ["stale_score"] });
  return o;
}

/* ---------------------------------------------------- action builder ----- */
function buildActions(x: {
  today: string; utilization: UtilizationView; collections: Awaited<ReturnType<typeof listCollections>>; collectionsSummary: CollectionsSummary;
  inquirySummary: InquirySummary; accounts: Awaited<ReturnType<typeof listAccounts>>; goals: Awaited<ReturnType<typeof listGoals>>;
  latest: Awaited<ReturnType<typeof listScores>>[number] | null; staleScore: boolean; cashFlow: CashFlowContext; history: HistorySummary;
}): CreditActionCard[] {
  const a: CreditActionCard[] = [];
  const URG: Record<CreditActionCard["urgency"], number> = { high: 3, medium: 2, low: 1 };
  // 1 verify a collection (+ written terms)
  const unverified = x.collections.filter((c) => COLLECTION_ACTIVE(c.status) && ["not_requested", "requested", "incomplete"].includes(c.validationStatus));
  if (unverified.length) { const c = unverified[0];
    a.push({ key: `verify_collection:${c.id}`, actionType: "verify_collection", title: `Verify the ${c.collectorName} collection`, observation: `${c.collectorName} reports a ${money(num(c.reportedBalance))} collection that you have not validated.`, why: "You should confirm a debt is valid, yours, and accurately reported before paying — paying an unverified debt can be a mistake.", nextStep: "Send a written debt-validation request and, if you consider settling, obtain the settlement terms in writing before paying.", estimatedCost: null, timing: "Before making any payment.", tradeoff: "Verifying takes time but protects you from paying an invalid or inaccurate debt.", verificationNeeded: "Request written validation and written settlement terms from the collector.", confidence: "high", domain: "credit", urgency: "high", estimatedUpside: "Avoids paying an invalid or inaccurate debt; possible removal if unvalidated.", timeRequired: "1–2 hours plus mail time", riskLevel: "low", evidence: `validation ${c.validationStatus}, balance ${money(num(c.reportedBalance))}`, professionalVerificationRecommended: true });
  }
  // 2 written terms (explicit when a settlement offer exists)
  const withOffer = x.collections.find((c) => COLLECTION_ACTIVE(c.status) && c.settlementOffer != null);
  if (withOffer) a.push({ key: `written_terms:${withOffer.id}`, actionType: "obtain_written_terms", title: `Get written terms for ${withOffer.collectorName}`, observation: `You recorded a settlement offer of ${money(num(withOffer.settlementOffer))} for ${withOffer.collectorName}.`, why: "A verbal settlement offer is not binding — written pay-for-delete or settlement terms protect you.", nextStep: "Request the offer in writing (including any pay-for-delete agreement) before sending money.", estimatedCost: withOffer.settlementOffer != null ? round2(num(withOffer.settlementOffer)) : null, timing: "Before paying the offer.", tradeoff: "Insisting on written terms may slow settlement but prevents disputes later.", verificationNeeded: "Obtain the settlement/pay-for-delete agreement in writing.", confidence: "high", domain: "credit", urgency: "medium", estimatedUpside: "Protects the agreed terms; a paid collection does not guarantee a score change.", timeRequired: "30–60 minutes", riskLevel: "low", evidence: `offer ${money(num(withOffer.settlementOffer))}`, professionalVerificationRecommended: true });
  // 3 review upcoming payment
  const due = x.accounts.filter((c) => c.status === "open" && c.paymentDueDate && daysBetween(c.paymentDueDate!, x.today) >= 0 && daysBetween(c.paymentDueDate!, x.today) <= 14).sort((p, q) => (p.paymentDueDate! < q.paymentDueDate! ? -1 : 1))[0];
  if (due) { const beforePay = x.cashFlow.nextPaydayDate != null && due.paymentDueDate! < x.cashFlow.nextPaydayDate; const cost = due.minimumPayment != null ? round2(num(due.minimumPayment)) : null; const conflict = beforePay && cost != null && x.cashFlow.available != null && cost > x.cashFlow.available;
    a.push({ key: `review_payment:${due.id}`, actionType: "review_payment", title: `Review the ${due.name} payment due ${due.paymentDueDate}`, observation: `A ${due.name} payment${due.minimumPayment ? ` (min ${money(num(due.minimumPayment))})` : ""} is due on ${due.paymentDueDate}${beforePay ? ", before your next expected paycheck" : ""}.`, why: "On-time payments are one of the most important credit factors.", nextStep: "Confirm the payment is scheduled through your bank or lender — Xanther does not pay it for you.", estimatedCost: cost, timing: beforePay ? "Before your next paycheck." : `By ${due.paymentDueDate}.`, tradeoff: conflict ? `Paying ${money(cost!)} now could strain cash flow — your estimated available cash after upcoming bills is ${money(x.cashFlow.available!)}. Do not use rent or essential-bill funds; at minimum keep the account current.` : "Missing it can hurt payment history; paying more than the minimum reduces interest but uses cash.", verificationNeeded: "Confirm the due date and minimum with your lender.", confidence: "high", domain: "credit", urgency: beforePay ? "high" : "medium", estimatedUpside: "Preserves on-time payment history.", timeRequired: "10 minutes", riskLevel: conflict ? "medium" : "low", evidence: `due ${due.paymentDueDate}`, professionalVerificationRecommended: false });
  }
  // 4 reduce utilization
  if (x.utilization.aggregatePct != null && x.utilization.aggregatePct >= 30) { const to30 = x.utilization.toReach.find((t) => t.threshold === 30)!.amount; const conflict = x.cashFlow.available != null && to30 > x.cashFlow.available;
    a.push({ key: `reduce_utilization:${x.today}`, actionType: "reduce_utilization", title: "Consider lowering revolving utilization", observation: `Your revolving utilization is about ${Math.round(x.utilization.aggregatePct)}% (${money(x.utilization.totalBalance)} of ${money(x.utilization.totalLimit)}).`, why: `${UTIL_EDU_NOTE}`, nextStep: `Reducing reported balances by about ${money(to30)} would bring utilization under 30%. Pay only what your cash flow safely allows.`, estimatedCost: to30, timing: "Before your next statement dates, if affordable.", tradeoff: conflict ? `Paying ${money(to30)} may exceed your estimated available cash (${money(x.cashFlow.available!)}) — do not use essential-bill or rent money; even a partial paydown helps.` : "Using cash to pay down balances reduces liquidity; keep an emergency buffer.", verificationNeeded: "Confirm current balances and limits with each issuer.", confidence: "high", domain: "credit", urgency: conflict ? "medium" : "medium", estimatedUpside: `Lower reported utilization may support a healthier profile — ${NO_GUARANTEE}`, timeRequired: "varies", riskLevel: conflict ? "medium" : "low", evidence: `to <30%: ${money(to30)}`, professionalVerificationRecommended: false });
  }
  // 5 update stale score
  if (!x.latest || x.staleScore) a.push({ key: `update_score:${x.today}`, actionType: "update_score", title: x.latest ? "Update your score data" : "Add your first score snapshot", observation: x.latest ? `Your latest score (${x.latest.source}, ${x.latest.asOfDate}) is over ${STALE_SCORE_DAYS} days old.` : "No score snapshot has been entered yet.", why: "Guidance is only as current as your manual data.", nextStep: "Record your latest score from a source you trust (bank, bureau, or Credit Karma), including the source and date.", estimatedCost: null, timing: "Monthly is a reasonable cadence.", tradeoff: "Takes a few minutes; keeps trends meaningful.", verificationNeeded: "Use a source you can access directly.", confidence: "high", domain: "credit", urgency: "low", estimatedUpside: "More accurate observations and trends.", timeRequired: "5 minutes", riskLevel: "low", evidence: x.latest ? `latest ${x.latest.asOfDate}` : "no score", professionalVerificationRecommended: false });
  // 6 confirm limits/balances
  if (x.utilization.missingLimitCount > 0) a.push({ key: `confirm_limits:${x.today}`, actionType: "confirm_limits", title: "Add missing credit limits", observation: `${x.utilization.missingLimitCount} revolving account(s) have no credit limit recorded, so utilization is incomplete.`, why: "Utilization can only be calculated with a valid limit.", nextStep: "Add each card's current limit and balance from your statement or issuer app.", estimatedCost: null, timing: "When convenient.", tradeoff: "A few minutes of entry for accurate utilization.", verificationNeeded: "Confirm limits with each issuer.", confidence: "high", domain: "credit", urgency: "low", estimatedUpside: "Accurate utilization and better guidance.", timeRequired: "10 minutes", riskLevel: "low", evidence: `${x.utilization.missingLimitCount} missing limit(s)`, professionalVerificationRecommended: false });
  // 7 avoid applications after recent inquiries
  if (x.inquirySummary.recentHardCount >= 2) a.push({ key: `avoid_applications:${x.today}`, actionType: "avoid_new_applications", title: "Consider pausing new credit applications", observation: `You recorded ${x.inquirySummary.recentHardCount} hard inquiries in the last 6 months.`, why: "Multiple recent hard inquiries can weigh on a profile and signal risk to lenders.", nextStep: "Consider avoiding unnecessary applications while these inquiries remain recent, unless a specific need justifies one.", estimatedCost: null, timing: "Over the next several months.", tradeoff: "Waiting may delay a desired account but avoids compounding recent inquiries.", verificationNeeded: "Review which inquiries were intentional.", confidence: "medium", domain: "credit", urgency: "medium", estimatedUpside: `Avoids adding further recent inquiries — ${NO_GUARANTEE}`, timeRequired: "n/a", riskLevel: "low", evidence: `${x.inquirySummary.recentHardCount} recent hard inquiries`, professionalVerificationRecommended: false });
  // 8 create/review a goal
  if (!x.goals.some((g) => g.status === "active")) a.push({ key: `review_goal:${x.today}`, actionType: "review_goal", title: "Set a credit goal", observation: "You have no active credit goal.", why: "A clear target (score, utilization, or collection resolution) makes progress measurable.", nextStep: "Create a goal such as a target score or utilization under 30%.", estimatedCost: null, timing: "Any time.", tradeoff: "None — a goal is informational.", verificationNeeded: "None.", confidence: "medium", domain: "credit", urgency: "low", estimatedUpside: "Clear direction and measurable progress.", timeRequired: "5 minutes", riskLevel: "low", evidence: "no active goal", professionalVerificationRecommended: false });
  // 9 preserve on-time streak
  if (x.history.latePaymentCount === 0 && x.accounts.some((c) => c.status === "open")) a.push({ key: `preserve_streak:${x.today}`, actionType: "preserve_streak", title: "Preserve your on-time payment streak", observation: "You have no recorded late payments.", why: "Payment history is a major credit factor and a clean streak is worth protecting.", nextStep: "Keep every account current — consider autopay for at least the minimum.", estimatedCost: null, timing: "Ongoing.", tradeoff: "Autopay requires a funded account; confirm cash is available.", verificationNeeded: "Confirm autopay covers at least the minimum.", confidence: "medium", domain: "credit", urgency: "low", estimatedUpside: "Protects payment history.", timeRequired: "10 minutes", riskLevel: "low", evidence: "0 late records", professionalVerificationRecommended: false });
  // 10 resolve incomplete data
  if (x.history.incomplete && x.utilization.missingLimitCount === 0) a.push({ key: `resolve_incomplete_data:${x.today}`, actionType: "resolve_incomplete_data", title: "Complete your credit profile details", observation: "Some accounts are missing dates or details that improve credit-age and history figures.", why: "Age of accounts and complete history make guidance more accurate.", nextStep: "Add opened dates and any missing account details.", estimatedCost: null, timing: "When convenient.", tradeoff: "A few minutes for more accurate history metrics.", verificationNeeded: "Confirm details from statements.", confidence: "low", domain: "credit", urgency: "low", estimatedUpside: "More accurate credit-age and history metrics.", timeRequired: "10 minutes", riskLevel: "low", evidence: "incomplete account dates", professionalVerificationRecommended: false });

  return a.sort((p, q) => URG[q.urgency] - URG[p.urgency] || p.key.localeCompare(q.key));
}

/* ---------------------------------------------------- health builder ----- */
function buildHealth(x: {
  scores: Awaited<ReturnType<typeof listScores>>; accounts: Awaited<ReturnType<typeof listAccounts>>; utilization: UtilizationView;
  collectionsSummary: CollectionsSummary; history: HistorySummary; lates: Awaited<ReturnType<typeof listLatePayments>>;
  goalProgress: CreditOverview["goalProgress"]; cashFlow: CashFlowContext; trends: ScoreTrend[]; staleScore: boolean;
}): HealthSummary {
  const sections: HealthSummary["sections"] = [];
  const completeness: Health = x.scores.length && x.accounts.length && x.utilization.missingLimitCount === 0 ? "good" : x.scores.length || x.accounts.length ? "attention" : "insufficient";
  sections.push({ key: "completeness", label: "Credit profile completeness", status: completeness, detail: completeness === "good" ? "Score and accounts are recorded with limits." : completeness === "attention" ? "Some credit data is entered but incomplete." : "Little or no credit data has been entered yet." });
  const openLates = x.lates.filter((l) => l.status === "reported").length; const overdue = x.accounts.some((a) => a.status === "open" && a.paymentDueDate && a.paymentDueDate < localToday() && num(a.currentBalance) > 0);
  const reliability: Health = !x.accounts.length ? "insufficient" : openLates === 0 && !overdue ? "good" : "attention";
  sections.push({ key: "reliability", label: "Payment reliability", status: reliability, detail: reliability === "good" ? "No unresolved late or overdue records." : reliability === "attention" ? `${openLates} unresolved late record(s)${overdue ? " and an overdue manual due date" : ""}.` : "No accounts entered to assess payment reliability." });
  const util: Health = x.utilization.aggregatePct == null ? "insufficient" : x.utilization.aggregatePct < 30 ? "good" : "attention";
  sections.push({ key: "utilization", label: "Revolving utilization", status: util, detail: x.utilization.aggregatePct == null ? "No revolving account with a valid limit entered." : `Approximately ${Math.round(x.utilization.aggregatePct)}%.` });
  const debt: Health = x.collectionsSummary.activeCount === 0 ? (x.accounts.length ? "good" : "insufficient") : "attention";
  sections.push({ key: "debt", label: "Debt and collection pressure", status: debt, detail: x.collectionsSummary.activeCount ? `${x.collectionsSummary.activeCount} active collection(s), ${money(x.collectionsSummary.activeBalance)}.` : x.accounts.length ? "No active collections recorded." : "Insufficient data." });
  const cash: Health = !x.cashFlow.ok || x.cashFlow.available == null ? "insufficient" : x.cashFlow.available > 0 ? "good" : "attention";
  sections.push({ key: "cash", label: "Cash-flow resilience", status: cash, detail: x.cashFlow.available == null ? "No finance data to assess cash flow." : `Estimated available after upcoming bills: ${money(x.cashFlow.available)}.` });
  const activeGoals = x.goalProgress.filter((g) => g.status === "active"); const goalHealth: Health = !activeGoals.length ? "insufficient" : activeGoals.every((g) => g.onTrack) ? "good" : "attention";
  sections.push({ key: "goals", label: "Progress toward goals", status: goalHealth, detail: !activeGoals.length ? "No active goals." : `${activeGoals.filter((g) => g.onTrack).length}/${activeGoals.length} goal(s) on track.` });

  const known = sections.filter((s) => s.status !== "insufficient");
  const scoreTrend = x.trends.find((t) => t.change != null);
  let overall: HealthSummary["overall"];
  const overallReasons = sections.map((s) => `${s.label}: ${s.status === "good" ? "Good" : s.status === "attention" ? "Needs attention" : "Insufficient data"}`);
  if (!known.length) overall = "insufficient";
  else if (known.some((s) => s.status === "attention")) overall = scoreTrend && scoreTrend.change! > 0 && known.filter((s) => s.status === "attention").length <= 1 ? "improving" : "attention";
  else overall = scoreTrend && scoreTrend.change! > 0 ? "improving" : "stable";
  return { sections, overall, overallReasons };
}

/* --------------------------------------------------------- Home ---------- */
export async function homeCreditSummary(userId: number): Promise<{ urgentAction: string | null; progress: string | null; staleReminder: string | null }> {
  const o = await computeCreditOverview(userId);
  const urgent = o.actions.find((a) => a.urgency === "high") ?? null;
  const progress = o.observations.find((ob) => ob.type === "score_change" && /increased/.test(ob.summary)) ?? o.observations.find((ob) => ob.type === "utilization_progress" || ob.type === "collection_resolution_progress" || ob.type === "goal_progress") ?? null;
  return {
    urgentAction: urgent ? urgent.title : null,
    progress: progress ? progress.title : null,
    staleReminder: o.staleScore ? "Your credit score data is over 45 days old — consider updating it." : null,
  };
}
