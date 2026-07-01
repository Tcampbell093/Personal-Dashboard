/* =============================================================================
 * Xanther — Finance 1B.5B: spending insights + opportunity detection.
 *
 * READ-ONLY financial intelligence. Every metric/insight/opportunity is a
 * DETERMINISTIC CALCULATED VIEW recomputed from current transaction data — it
 * NEVER mutates a transaction, category, merchant rule, balance, movement,
 * bill/income/transfer, provider snapshot, or cursor, and moves no money. No AI.
 * The only durable state is the owner's DISMISSAL of an insight (keyed by a
 * deterministic key that includes the evidence period). Every insight cleanly
 * distinguishes observed fact, deterministic calculation, inferred opportunity,
 * estimated upside, confidence, and limitations.
 * ===========================================================================*/

if (typeof window !== "undefined") {
  throw new Error("insights service is server-only and must not be imported in the browser.");
}

import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  importedTransactions, transactionCategoryAssignments, transactionCategories,
  financialEventEvidence, financialInsightDismissals,
} from "@/db/schema";
import { localToday } from "@/lib/time";
import { normalizeMerchant } from "./categories";

export class InsightError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.name = "InsightError"; this.status = status; }
}

const num = (s: string | null | undefined) => (s == null ? 0 : Number(s));
const money = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const money2 = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/* ------------------------------------------- thresholds (documented) ------ */
export const THRESHOLDS = {
  change: { absMin: 25, pctMin: 0.20, currentMin: 40 }, // meaningful category/merchant change
  recurring: { minCount: 3, amtAbs: 2, amtPct: 0.10 }, // ≥3 charges, similar amount
  unusual: { medianMult: 2.5, minOverMedian: 50, minHistory: 4 }, // vs merchant median
  concentration: { merchantPct: 0.35 }, // one merchant > 35% of categorized outflow
  coverageWarn: 0.25, // warn when >25% of spending is uncategorized
  minHistoryDays: 20, // shorter history → suppress period conclusions
} as const;

/* -------------------------------------------------- date helpers (NY) ----- */
function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function dayDiff(a: string, b: string): number {
  const pa = a.slice(0, 10).split("-").map(Number), pb = b.slice(0, 10).split("-").map(Number);
  return Math.round((Date.UTC(pa[0], pa[1] - 1, pa[2]) - Date.UTC(pb[0], pb[1] - 1, pb[2])) / 86400000);
}
const monthStart = (iso: string) => `${iso.slice(0, 7)}-01`;
function monthEnd(iso: string): string { const [y, m] = iso.slice(0, 7).split("-").map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); }
function prevMonthOf(iso: string): string { const [y, m] = iso.slice(0, 7).split("-").map(Number); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7); }

export type PeriodKey = "current_month" | "previous_month" | "last_30" | "last_90" | string; // or "YYYY-MM"
export interface Period { key: string; label: string; start: string; end: string; priorStart: string; priorEnd: string; priorLabel: string; incomplete: boolean; }

/** Resolve a bounded period + its comparable prior period (America/New_York). A
 * month-to-date current period compares against the SAME number of elapsed days
 * of the prior month and is labeled incomplete. */
export function resolvePeriod(period: PeriodKey, now: string = localToday()): Period {
  if (period === "previous_month") {
    const pm = prevMonthOf(now); const start = `${pm}-01`, end = monthEnd(`${pm}-01`);
    const pm2 = prevMonthOf(start); const priorStart = `${pm2}-01`, priorEnd = monthEnd(`${pm2}-01`);
    return { key: "previous_month", label: "Last month", start, end, priorStart, priorEnd, priorLabel: "the month before", incomplete: false };
  }
  if (period === "last_30") {
    const start = addDays(now, -29), end = now, priorEnd = addDays(now, -30), priorStart = addDays(now, -59);
    return { key: "last_30", label: "Last 30 days", start, end, priorStart, priorEnd, priorLabel: "the preceding 30 days", incomplete: false };
  }
  if (period === "last_90") {
    const start = addDays(now, -89), end = now, priorEnd = addDays(now, -90), priorStart = addDays(now, -179);
    return { key: "last_90", label: "Last 90 days", start, end, priorStart, priorEnd, priorLabel: "the preceding 90 days", incomplete: false };
  }
  if (/^\d{4}-\d{2}$/.test(period)) {
    const start = `${period}-01`, end = monthEnd(start); const pm = prevMonthOf(start);
    return { key: period, label: period, start, end, priorStart: `${pm}-01`, priorEnd: monthEnd(`${pm}-01`), priorLabel: "the prior month", incomplete: end > now };
  }
  // current_month (default) — month-to-date vs same elapsed days prior month.
  const start = monthStart(now), end = now, elapsed = dayDiff(now, start); // days elapsed this month (0-based)
  const pm = prevMonthOf(now); const priorStart = `${pm}-01`, priorEnd = addDays(priorStart, elapsed);
  return { key: "current_month", label: "This month", start, end, priorStart, priorEnd, priorLabel: `the first ${elapsed + 1} days of last month`, incomplete: true };
}

/* ---------------------------------------------------------- eligibility --- */
type Txn = typeof importedTransactions.$inferSelect;
interface Loaded { txns: Txn[]; catByTxn: Map<number, { id: number; name: string; kind: string }>; transferTxn: Set<number>; cats: Map<number, { id: number; name: string; kind: string }>; }

async function loadData(userId: number): Promise<Loaded> {
  const txns = await db.select().from(importedTransactions).where(and(eq(importedTransactions.userId, userId), isNull(importedTransactions.deletedAt)));
  const catRows = await db.select().from(transactionCategories).where(eq(transactionCategories.userId, userId));
  const cats = new Map(catRows.map((c) => [c.id, { id: c.id, name: c.name, kind: c.kind }]));
  const assigns = await db.select().from(transactionCategoryAssignments).where(and(eq(transactionCategoryAssignments.userId, userId), eq(transactionCategoryAssignments.status, "confirmed")));
  const catByTxn = new Map<number, { id: number; name: string; kind: string }>();
  for (const a of assigns) { const c = cats.get(a.categoryId); if (c) catByTxn.set(a.transactionId, c); }
  // Confirmed transfer evidence → exclude these transactions from spending.
  const ev = await db.select().from(financialEventEvidence).where(and(eq(financialEventEvidence.userId, userId), eq(financialEventEvidence.eventType, "transfer")));
  const transferTxn = new Set(ev.flatMap((e) => [e.primaryTransactionId, e.secondaryTransactionId].filter((x): x is number => x != null)));
  return { txns, catByTxn, transferTxn, cats };
}

/** Eligible SPENDING transactions in a window: active + posted (not pending) +
 * outflow + NOT a confirmed transfer. (Removed/pending/inflow/transfer excluded;
 * duplicates can't exist — the provider transaction id is unique per connection.) */
function spendingIn(d: Loaded, start: string, end: string): Txn[] {
  return d.txns.filter((t) => t.status === "active" && !t.isPending && num(t.amount) < 0 && !d.transferTxn.has(t.id) && t.postedDate != null && t.postedDate >= start && t.postedDate <= end);
}

/* ------------------------------------------------------- fee detection ---- */
export function detectFee(desc: string | null | undefined, category: string | null | undefined): { isFee: boolean; type: string | null } {
  const s = `${desc ?? ""} ${category ?? ""}`.toLowerCase();
  if (/overdraft/.test(s)) return { isFee: true, type: "Overdraft fee" };
  if (/\bnsf\b/.test(s)) return { isFee: true, type: "NSF fee" };
  if (/\batm\b.{0,14}(fee|charge|withdrawal)|atm fee/.test(s)) return { isFee: true, type: "ATM fee" };
  if (/(maintenance|monthly|account)\s+(fee|charge)/.test(s)) return { isFee: true, type: "Maintenance fee" };
  if (/late\s+(fee|charge)/.test(s)) return { isFee: true, type: "Late fee" };
  if (/foreign\s+transaction/.test(s)) return { isFee: true, type: "Foreign transaction fee" };
  if (/service\s+(fee|charge)/.test(s)) return { isFee: true, type: "Service fee" };
  if (/interest\s+(charge|fee)|finance\s+charge/.test(s)) return { isFee: true, type: "Interest charge" };
  if (/\bfee\b/.test(s)) return { isFee: true, type: "Fee" }; // \bfee\b never matches "coffee"/"toffee"
  return { isFee: false, type: null };
}

const median = (xs: number[]): number => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const bandOf = (n: number): "high" | "medium" | "low" => (n >= 85 ? "high" : n >= 65 ? "medium" : "low");

/* ------------------------------------------------------------- views ------ */
export interface CategoryTotalView { categoryId: number | null; name: string; kind: string; total: number; count: number; average: number; largest: number; pct: number; priorTotal: number; change: number; changePct: number | null; }
export interface MerchantTotalView { merchant: string; total: number; count: number; average: number; categoryName: string | null; share: number; priorTotal: number; change: number; }
export interface InsightCard { key: string; type: string; title: string; summary: string; confidence: "high" | "medium" | "low"; reasonCodes: string[]; periodStart: string; periodEnd: string; metricValue: number; comparisonValue: number | null; relatedCategoryId: number | null; relatedMerchant: string | null; relatedTransactionIds: number[]; why: string; }
export interface OpportunityCard { key: string; type: string; observation: string; why: string; estimatedUpsideMin: number | null; estimatedUpsideMax: number | null; upsideLabel: string; confidence: "high" | "medium" | "low"; nextAction: string; limitation: string; evidencePeriod: string; reasonCodes: string[]; }
export interface InsightsView {
  period: { key: string; label: string; start: string; end: string; incomplete: boolean; priorLabel: string };
  coverage: { totalPostedActive: number; uncategorizedCount: number; uncategorizedAmount: number; categorizedAmount: number; coveragePct: number; warning: string | null; shortHistory: boolean };
  totals: { totalSpending: number; transferExcluded: number; incomeExcluded: number };
  categoryTotals: CategoryTotalView[]; merchantTotals: MerchantTotalView[];
  insights: InsightCard[]; opportunities: OpportunityCard[];
}

const RECUR = "recurring", UNCAT = "uncat";
export async function computeInsights(userId: number, opts: { period?: PeriodKey; type?: string; includeLowConfidence?: boolean; now?: string } = {}): Promise<InsightsView> {
  const now = opts.now ?? localToday();
  const P = resolvePeriod(opts.period ?? "current_month", now);
  const d = await loadData(userId);
  const cur = spendingIn(d, P.start, P.end);
  const prior = spendingIn(d, P.priorStart, P.priorEnd);
  const dismissed = new Set((await db.select({ k: financialInsightDismissals.insightKey }).from(financialInsightDismissals).where(eq(financialInsightDismissals.userId, userId))).map((r) => r.k));

  const totalSpending = cur.reduce((s, t) => s + Math.abs(num(t.amount)), 0);
  // Coverage: all active posted outflows in the period (transfers excluded from spend already).
  const uncatTxns = cur.filter((t) => !d.catByTxn.has(t.id));
  const uncategorizedAmount = uncatTxns.reduce((s, t) => s + Math.abs(num(t.amount)), 0);
  const categorizedAmount = totalSpending - uncategorizedAmount;
  const coveragePct = totalSpending > 0 ? categorizedAmount / totalSpending : 1;
  const shortHistory = d.txns.filter((t) => t.status === "active" && !t.isPending && t.postedDate).reduce((min, t) => (t.postedDate! < min ? t.postedDate! : min), now) > addDays(now, -THRESHOLDS.minHistoryDays);
  const coverageWarning = totalSpending > 0 && (1 - coveragePct) > THRESHOLDS.coverageWarn ? `${Math.round((1 - coveragePct) * 100)}% of spending is still uncategorized — category insights are limited until more is categorized.` : null;

  // excluded amounts (for honest reporting)
  const inWindow = (t: Txn) => t.status === "active" && !t.isPending && t.postedDate != null && t.postedDate >= P.start && t.postedDate <= P.end;
  const transferExcluded = d.txns.filter((t) => inWindow(t) && d.transferTxn.has(t.id) && num(t.amount) < 0).reduce((s, t) => s + Math.abs(num(t.amount)), 0);
  const incomeExcluded = d.txns.filter((t) => inWindow(t) && num(t.amount) > 0 && !d.transferTxn.has(t.id)).reduce((s, t) => s + num(t.amount), 0);

  /* ---- category totals + comparison ---- */
  const catAgg = new Map<string, { catId: number | null; name: string; kind: string; amts: number[] }>();
  for (const t of cur) { const c = d.catByTxn.get(t.id); const key = c ? String(c.id) : "uncat"; const e = catAgg.get(key) ?? { catId: c?.id ?? null, name: c?.name ?? "Uncategorized", kind: c?.kind ?? "neutral", amts: [] }; e.amts.push(Math.abs(num(t.amount))); catAgg.set(key, e); }
  const priorCat = new Map<string, number>();
  for (const t of prior) { const c = d.catByTxn.get(t.id); const key = c ? String(c.id) : "uncat"; priorCat.set(key, (priorCat.get(key) ?? 0) + Math.abs(num(t.amount))); }
  const categoryTotals: CategoryTotalView[] = [...catAgg.entries()].map(([key, e]) => {
    const total = e.amts.reduce((a, b) => a + b, 0); const priorTotal = priorCat.get(key) ?? 0;
    return { categoryId: e.catId, name: e.name, kind: e.kind, total: Math.round(total * 100) / 100, count: e.amts.length, average: Math.round((total / e.amts.length) * 100) / 100, largest: Math.max(...e.amts), pct: totalSpending > 0 ? Math.round((total / totalSpending) * 1000) / 10 : 0, priorTotal: Math.round(priorTotal * 100) / 100, change: Math.round((total - priorTotal) * 100) / 100, changePct: priorTotal > 0 ? Math.round(((total - priorTotal) / priorTotal) * 1000) / 10 : null };
  }).sort((a, b) => b.total - a.total);

  /* ---- merchant totals + comparison ---- */
  const merchAgg = new Map<string, { name: string; amts: number[]; cat: string | null }>();
  for (const t of cur) { const nm = normalizeMerchant(t.merchantName ?? t.descriptionCurrent); if (!nm) continue; const e = merchAgg.get(nm) ?? { name: t.merchantName ?? t.descriptionCurrent, amts: [], cat: d.catByTxn.get(t.id)?.name ?? null }; e.amts.push(Math.abs(num(t.amount))); if (!e.cat && d.catByTxn.get(t.id)) e.cat = d.catByTxn.get(t.id)!.name; merchAgg.set(nm, e); }
  const priorMerch = new Map<string, number>();
  for (const t of prior) { const nm = normalizeMerchant(t.merchantName ?? t.descriptionCurrent); if (!nm) continue; priorMerch.set(nm, (priorMerch.get(nm) ?? 0) + Math.abs(num(t.amount))); }
  const merchantTotals: MerchantTotalView[] = [...merchAgg.entries()].map(([nm, e]) => {
    const total = e.amts.reduce((a, b) => a + b, 0); const priorTotal = priorMerch.get(nm) ?? 0;
    return { merchant: e.name, total: Math.round(total * 100) / 100, count: e.amts.length, average: Math.round((total / e.amts.length) * 100) / 100, categoryName: e.cat, share: totalSpending > 0 ? Math.round((total / totalSpending) * 1000) / 10 : 0, priorTotal: Math.round(priorTotal * 100) / 100, change: Math.round((total - priorTotal) * 100) / 100 };
  }).sort((a, b) => b.total - a.total || a.merchant.localeCompare(b.merchant));

  /* ================= insights ================= */
  const insights: InsightCard[] = [];
  const incNote = P.incomplete ? ` (${P.label.toLowerCase()} so far vs ${P.priorLabel})` : ` vs ${P.priorLabel}`;

  // category_change
  for (const c of categoryTotals) {
    if (c.categoryId == null) continue;
    if (c.change >= THRESHOLDS.change.absMin && c.total >= THRESHOLDS.change.currentMin && c.changePct != null && c.changePct >= THRESHOLDS.change.pctMin * 100) {
      insights.push({ key: `category_change:${P.key}:${c.categoryId}`, type: "category_change", title: `${c.name} up ${money(c.change)}`, summary: `${c.name} increased by ${money(c.change)}, up ${Math.round(c.changePct)}%${incNote}.`, confidence: P.incomplete ? "medium" : "high", reasonCodes: ["category_total_calculated", "period_increase"], periodStart: P.start, periodEnd: P.end, metricValue: c.total, comparisonValue: c.priorTotal, relatedCategoryId: c.categoryId, relatedMerchant: null, relatedTransactionIds: [], why: "Calculated from your confirmed category totals for this period versus the comparable prior period." });
    } else if (c.change <= -THRESHOLDS.change.absMin && c.priorTotal >= THRESHOLDS.change.currentMin) {
      insights.push({ key: `category_change:${P.key}:${c.categoryId}`, type: "category_change", title: `${c.name} down ${money(Math.abs(c.change))}`, summary: `${c.name} decreased by ${money(Math.abs(c.change))} compared with ${P.priorLabel}.`, confidence: "medium", reasonCodes: ["category_total_calculated", "period_decrease"], periodStart: P.start, periodEnd: P.end, metricValue: c.total, comparisonValue: c.priorTotal, relatedCategoryId: c.categoryId, relatedMerchant: null, relatedTransactionIds: [], why: "Calculated from your confirmed category totals — lower spending than the prior period." });
    }
  }
  // merchant_change
  for (const m of merchantTotals.slice(0, 12)) {
    if (m.change >= THRESHOLDS.change.absMin && m.total >= THRESHOLDS.change.currentMin && m.priorTotal > 0 && (m.change / m.priorTotal) >= THRESHOLDS.change.pctMin) {
      const nm = normalizeMerchant(m.merchant);
      insights.push({ key: `merchant_change:${P.key}:${nm}`, type: "merchant_change", title: `${m.merchant} up ${money(m.change)}`, summary: `Spending at ${m.merchant} increased by ${money(m.change)}${incNote}.`, confidence: P.incomplete ? "medium" : "high", reasonCodes: ["merchant_total_calculated", "period_increase"], periodStart: P.start, periodEnd: P.end, metricValue: m.total, comparisonValue: m.priorTotal, relatedCategoryId: null, relatedMerchant: m.merchant, relatedTransactionIds: [], why: "Calculated from your spending at this merchant versus the comparable prior period." });
    }
  }
  // spending_concentration
  const topMerch = merchantTotals[0];
  if (topMerch && totalSpending > 0 && topMerch.total / totalSpending >= THRESHOLDS.concentration.merchantPct && topMerch.count >= 2) {
    insights.push({ key: `spending_concentration:${P.key}:${normalizeMerchant(topMerch.merchant)}`, type: "spending_concentration", title: `${topMerch.merchant} is ${topMerch.share}% of spending`, summary: `${topMerch.merchant} accounts for ${topMerch.share}% of your categorized outflow this period.`, confidence: "medium", reasonCodes: ["merchant_concentration"], periodStart: P.start, periodEnd: P.end, metricValue: topMerch.total, comparisonValue: totalSpending, relatedCategoryId: null, relatedMerchant: topMerch.merchant, relatedTransactionIds: [], why: "The share is your merchant total divided by total categorized outflow for the period." });
  }
  // fee_detected
  const feeTxns = cur.filter((t) => detectFee(t.merchantName ?? t.descriptionCurrent, t.categoryPrimary ?? t.categoryDetailed).isFee);
  if (feeTxns.length) {
    const feeTotal = feeTxns.reduce((s, t) => s + Math.abs(num(t.amount)), 0);
    const types = [...new Set(feeTxns.map((t) => detectFee(t.merchantName ?? t.descriptionCurrent, t.categoryPrimary).type))];
    insights.push({ key: `fee_detected:${P.key}`, type: "fee_detected", title: `${money2(feeTotal)} in fees`, summary: `You paid ${money2(feeTotal)} in fees across ${feeTxns.length} transaction${feeTxns.length === 1 ? "" : "s"} (${types.join(", ")}).`, confidence: feeTxns.length >= 2 ? "high" : "medium", reasonCodes: ["fee_description_match"], periodStart: P.start, periodEnd: P.end, metricValue: Math.round(feeTotal * 100) / 100, comparisonValue: null, relatedCategoryId: null, relatedMerchant: null, relatedTransactionIds: feeTxns.map((t) => t.id), why: "Detected from conservative fee keywords in the transaction description/category. Some fees may be unavoidable." });
  }
  // recurring_charge
  for (const [nm, e] of merchAgg.entries()) {
    const all = d.txns.filter((t) => t.status === "active" && !t.isPending && num(t.amount) < 0 && !d.transferTxn.has(t.id) && normalizeMerchant(t.merchantName ?? t.descriptionCurrent) === nm && t.postedDate).sort((a, b) => a.postedDate!.localeCompare(b.postedDate!));
    if (all.length < THRESHOLDS.recurring.minCount) continue;
    const amts = all.map((t) => Math.abs(num(t.amount))); const med = median(amts); const tol = Math.max(THRESHOLDS.recurring.amtAbs, med * THRESHOLDS.recurring.amtPct);
    if (amts.some((a) => Math.abs(a - med) > tol)) continue; // amount too variable
    const intervals: number[] = []; for (let i = 1; i < all.length; i++) intervals.push(dayDiff(all[i].postedDate!, all[i - 1].postedDate!));
    const medInt = median(intervals);
    const cadence = medInt <= 9 ? "weekly" : medInt <= 17 ? "every two weeks" : medInt <= 45 ? "monthly" : medInt <= 120 ? "quarterly" : "annual";
    const irregular = intervals.some((iv) => Math.abs(iv - medInt) > Math.max(4, medInt * 0.4));
    if (irregular && all.length < 4) continue; // irregular + little history → skip
    const last = all[all.length - 1].postedDate!; const nextMin = addDays(last, Math.round(medInt * 0.85)); const nextMax = addDays(last, Math.round(medInt * 1.15));
    const conf = irregular ? "low" : all.length >= 4 ? "high" : "medium";
    insights.push({ key: `recurring_charge:${P.key}:${nm}`, type: "recurring_charge", title: `${e.name} appears ${cadence}`, summary: `This appears to be a recurring ${cadence} charge of about ${money2(med)} at ${e.name}. Next likely between ${nextMin} and ${nextMax}.`, confidence: conf, reasonCodes: ["recurring_amount_pattern", "recurring_interval_pattern"], periodStart: P.start, periodEnd: P.end, metricValue: Math.round(med * 100) / 100, comparisonValue: null, relatedCategoryId: null, relatedMerchant: e.name, relatedTransactionIds: all.map((t) => t.id), why: `Detected because this merchant has ${all.length} similar-amount posted charges at a roughly ${cadence} interval. It is not confirmed to be a subscription.` });
  }
  // unusual_transaction
  for (const [nm, e] of merchAgg.entries()) {
    const hist = d.txns.filter((t) => t.status === "active" && !t.isPending && num(t.amount) < 0 && !d.transferTxn.has(t.id) && normalizeMerchant(t.merchantName ?? t.descriptionCurrent) === nm).map((t) => Math.abs(num(t.amount)));
    if (hist.length < THRESHOLDS.unusual.minHistory) continue;
    const med = median(hist);
    const outlier = cur.find((t) => normalizeMerchant(t.merchantName ?? t.descriptionCurrent) === nm && Math.abs(num(t.amount)) >= med * THRESHOLDS.unusual.medianMult && Math.abs(num(t.amount)) >= med + THRESHOLDS.unusual.minOverMedian);
    if (!outlier) continue;
    insights.push({ key: `unusual_transaction:${P.key}:${outlier.id}`, type: "unusual_transaction", title: `Unusual charge at ${e.name}`, summary: `A ${money2(Math.abs(num(outlier.amount)))} charge at ${e.name} is unusual compared with your recent activity (typical ${money2(med)}).`, confidence: "medium", reasonCodes: ["unusual_vs_merchant_median"], periodStart: P.start, periodEnd: P.end, metricValue: Math.abs(num(outlier.amount)), comparisonValue: med, relatedCategoryId: null, relatedMerchant: e.name, relatedTransactionIds: [outlier.id], why: `This charge is more than ${THRESHOLDS.unusual.medianMult}× your typical amount at this merchant (based on ${hist.length} prior charges). This is not fraud detection.` });
  }
  // uncategorized_gap
  if (totalSpending > 0 && (1 - coveragePct) > THRESHOLDS.coverageWarn && uncatTxns.length > 0) {
    insights.push({ key: `uncategorized_gap:${P.key}`, type: "uncategorized_gap", title: `${uncatTxns.length} transactions uncategorized`, summary: `${Math.round((1 - coveragePct) * 100)}% of this period's spending (${money2(uncategorizedAmount)}) is not yet categorized.`, confidence: "high", reasonCodes: ["uncategorized_coverage_low"], periodStart: P.start, periodEnd: P.end, metricValue: uncategorizedAmount, comparisonValue: totalSpending, relatedCategoryId: null, relatedMerchant: null, relatedTransactionIds: uncatTxns.map((t) => t.id), why: "Calculated as uncategorized spending divided by total spending. Category insights improve as you categorize more." });
  }

  /* ================= opportunities ================= */
  const opportunities: OpportunityCard[] = [];
  // reduce repeated discretionary merchant
  const repeat = merchantTotals.find((m) => m.count >= 4 && m.total >= 60 && (m.categoryName == null || /dining|shopping|entertainment|coffee|subscriptions|travel/i.test(m.categoryName)));
  if (repeat) {
    const avg = repeat.average; const upMin = Math.round(avg * 100) / 100; const upMax = Math.min(repeat.total * 0.5, Math.round(avg * 2 * 100) / 100);
    opportunities.push({ key: `opportunity:reduce_merchant:${P.key}:${normalizeMerchant(repeat.merchant)}`, type: "opportunity", observation: `You spent ${money2(repeat.total)} at ${repeat.merchant} across ${repeat.count} transactions this period.`, why: "Frequent discretionary spending at one merchant is often the easiest place to trim.", estimatedUpsideMin: upMin, estimatedUpsideMax: Math.round(upMax * 100) / 100, upsideLabel: `${money2(upMin)}–${money2(upMax)} per month`, confidence: repeat.count >= 6 ? "high" : "medium", nextAction: `Consider one or two fewer ${repeat.merchant} purchases next month.`, limitation: "Estimate uses your observed average and a bounded reduction (capped at half of observed spend); actual savings depend on your choices.", evidencePeriod: `${P.start} to ${P.end}`, reasonCodes: ["estimated_reduction_from_average"] });
  }
  // review fees
  if (feeTxns.length) {
    const feeTotal = feeTxns.reduce((s, t) => s + Math.abs(num(t.amount)), 0);
    opportunities.push({ key: `opportunity:review_fees:${P.key}`, type: "opportunity", observation: `You paid ${money2(feeTotal)} in fees across ${feeTxns.length} transaction${feeTxns.length === 1 ? "" : "s"} this period.`, why: "Some bank/service fees are avoidable by changing account settings or habits.", estimatedUpsideMin: feeTxns.length >= 2 ? Math.round(feeTotal * 100) / 100 : 0, estimatedUpsideMax: Math.round(feeTotal * 100) / 100, upsideLabel: `up to ${money2(feeTotal)} per month if avoidable`, confidence: feeTxns.length >= 2 ? "medium" : "low", nextAction: "Review these fee charges with your bank to see which are avoidable.", limitation: "Not every fee is avoidable — review each before assuming savings.", evidencePeriod: `${P.start} to ${P.end}`, reasonCodes: ["fee_description_match"] });
  }
  // review recurring charge
  const recur = insights.find((i) => i.type === "recurring_charge" && i.confidence !== "low");
  if (recur) {
    opportunities.push({ key: `opportunity:review_recurring:${P.key}:${recur.relatedMerchant}`, type: "opportunity", observation: `${recur.relatedMerchant} appears to be a recurring charge of about ${money2(recur.metricValue)}.`, why: "Recurring charges are worth reviewing periodically in case they are no longer needed.", estimatedUpsideMin: null, estimatedUpsideMax: Math.round(recur.metricValue * 100) / 100, upsideLabel: `Potential monthly savings of ${money2(recur.metricValue)} if this charge is unnecessary`, confidence: recur.confidence, nextAction: `Check whether the ${recur.relatedMerchant} charge is still needed.`, limitation: "We do not assume cancellation — only you can decide if it is unnecessary.", evidencePeriod: `${P.start} to ${P.end}`, reasonCodes: ["recurring_interval_pattern"] });
  }
  // categorize remaining
  if (uncatTxns.length >= 3 && (1 - coveragePct) > THRESHOLDS.coverageWarn) {
    opportunities.push({ key: `opportunity:categorize:${P.key}`, type: "opportunity", observation: `${uncatTxns.length} transactions (${money2(uncategorizedAmount)}) are uncategorized this period.`, why: "Categorizing them unlocks accurate category insights and change tracking.", estimatedUpsideMin: null, estimatedUpsideMax: null, upsideLabel: "Better insight accuracy", confidence: "high", nextAction: "Open Categorize transactions and assign the remaining transactions.", limitation: "This improves analysis quality rather than directly saving money.", evidencePeriod: `${P.start} to ${P.end}`, reasonCodes: ["uncategorized_coverage_low"] });
  }
  // reduce concentration
  const conc = insights.find((i) => i.type === "spending_concentration");
  if (conc) {
    opportunities.push({ key: `opportunity:concentration:${P.key}:${conc.relatedMerchant}`, type: "opportunity", observation: conc.summary, why: "When one merchant dominates spending, small changes there have the biggest effect.", estimatedUpsideMin: null, estimatedUpsideMax: null, upsideLabel: "Varies", confidence: "medium", nextAction: `Review whether ${conc.relatedMerchant} spending matches your priorities.`, limitation: "Concentration is not inherently bad — this is informational.", evidencePeriod: `${P.start} to ${P.end}`, reasonCodes: ["merchant_concentration"] });
  }
  // investigate rising category
  const rising = insights.find((i) => i.type === "category_change" && i.metricValue > (i.comparisonValue ?? 0));
  if (rising) {
    opportunities.push({ key: `opportunity:rising_category:${P.key}:${rising.relatedCategoryId}`, type: "opportunity", observation: rising.summary, why: "A rising category is worth a quick look to confirm the increase is intentional.", estimatedUpsideMin: null, estimatedUpsideMax: rising.comparisonValue != null ? Math.round((rising.metricValue - rising.comparisonValue) * 100) / 100 : null, upsideLabel: rising.comparisonValue != null ? `up to ${money2(rising.metricValue - rising.comparisonValue)} if returned to prior levels` : "Varies", confidence: rising.confidence, nextAction: "Review the transactions driving this increase.", limitation: "The increase may be intentional or one-time.", evidencePeriod: `${P.start} to ${P.end}`, reasonCodes: ["period_increase"] });
  }

  // Deterministic priority ordering so the bounded slice surfaces the most
  // important, diverse insight types (a fee leak or unusual charge must not be
  // crowded out by many routine category/merchant changes). Ties broken by
  // magnitude then key for full determinism.
  const TYPE_PRIORITY: Record<string, number> = { fee_detected: 100, unusual_transaction: 90, uncategorized_gap: 80, recurring_charge: 70, spending_concentration: 60, category_change: 50, merchant_change: 40 };
  const insMag = (i: InsightCard) => (i.type === "category_change" || i.type === "merchant_change") ? Math.abs(i.metricValue - (i.comparisonValue ?? 0)) : i.metricValue;
  insights.sort((a, b) => (TYPE_PRIORITY[b.type] ?? 0) - (TYPE_PRIORITY[a.type] ?? 0) || insMag(b) - insMag(a) || a.key.localeCompare(b.key));
  const OPP_PRIORITY: Record<string, number> = { review_fees: 100, categorize: 90, review_recurring: 80, reduce_merchant: 70, rising_category: 60, concentration: 50 };
  const oppKind = (k: string) => k.split(":")[1] ?? "";
  opportunities.sort((a, b) => (OPP_PRIORITY[oppKind(b.key)] ?? 0) - (OPP_PRIORITY[oppKind(a.key)] ?? 0) || (b.estimatedUpsideMax ?? 0) - (a.estimatedUpsideMax ?? 0) || a.key.localeCompare(b.key));

  // Filter: dismissed, low-confidence opportunities by default, and by type.
  const showLow = opts.includeLowConfidence === true;
  let outInsights = insights.filter((i) => !dismissed.has(i.key));
  let outOpps = opportunities.filter((o) => !dismissed.has(o.key) && (showLow || o.confidence !== "low"));
  if (opts.type) { outInsights = outInsights.filter((i) => i.type === opts.type); outOpps = outOpps.filter((o) => o.type === opts.type); }
  void RECUR; void UNCAT;

  return {
    period: { key: P.key, label: P.label, start: P.start, end: P.end, incomplete: P.incomplete, priorLabel: P.priorLabel },
    coverage: { totalPostedActive: cur.length, uncategorizedCount: uncatTxns.length, uncategorizedAmount: Math.round(uncategorizedAmount * 100) / 100, categorizedAmount: Math.round(categorizedAmount * 100) / 100, coveragePct: Math.round(coveragePct * 1000) / 10, warning: coverageWarning, shortHistory },
    totals: { totalSpending: Math.round(totalSpending * 100) / 100, transferExcluded: Math.round(transferExcluded * 100) / 100, incomeExcluded: Math.round(incomeExcluded * 100) / 100 },
    categoryTotals, merchantTotals: merchantTotals.slice(0, 10),
    insights: outInsights.slice(0, 8), opportunities: outOpps.slice(0, 5),
  };
}

/* --------------------------------------------------- dismiss / restore ---- */
export async function dismissInsight(userId: number, insightKey: string, opts: { period?: PeriodKey; now?: string } = {}): Promise<{ ok: true }> {
  if (!insightKey || insightKey.length > 240) throw new InsightError(400, "Invalid insight key.");
  const parts = insightKey.split(":");
  const insightType = parts[0] ?? "unknown";
  const periodKey = parts[1] ?? (opts.period ?? "current_month");
  const P = /^\d{4}-\d{2}$/.test(periodKey) ? resolvePeriod(periodKey, opts.now) : resolvePeriod(periodKey as PeriodKey, opts.now);
  await db.insert(financialInsightDismissals).values({ userId, insightKey, insightType, periodKey, periodStart: P.start, periodEnd: P.end }).onConflictDoNothing({ target: [financialInsightDismissals.userId, financialInsightDismissals.insightKey] });
  return { ok: true };
}

export async function restoreInsight(userId: number, insightKey: string): Promise<{ ok: true }> {
  await db.delete(financialInsightDismissals).where(and(eq(financialInsightDismissals.userId, userId), eq(financialInsightDismissals.insightKey, insightKey)));
  return { ok: true };
}

/* ------------------------------------------------------------ home -------- */
export async function homeInsightSummary(userId: number): Promise<{ topInsight: string | null; topOpportunity: string | null }> {
  // Rolling 30-day window so Home stays informative regardless of day-of-month
  // (the current-month view is near-empty on the 1st).
  const v = await computeInsights(userId, { period: "last_30" });
  const ins = v.insights.find((i) => i.confidence !== "low");
  const opp = v.opportunities.find((o) => o.confidence !== "low");
  return { topInsight: ins ? ins.summary : null, topOpportunity: opp ? `${opp.nextAction}${opp.estimatedUpsideMax ? ` (${opp.upsideLabel})` : ""}` : null };
}
