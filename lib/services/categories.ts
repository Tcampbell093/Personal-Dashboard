/* =============================================================================
 * Xanther — Finance 1B.5A: transaction categories + owner-approved merchant rules.
 *
 * Categorization is DESCRIPTIVE METADATA ONLY, stored separately from the
 * immutable imported-transaction bank evidence. It never mutates a transaction's
 * amount/date/pending/removed state, the Plaid cursor, a provider balance/snapshot,
 * a movement, a bill/income/transfer, or matching evidence — and it never moves
 * money. Suggestions are DETERMINISTIC (no AI). A permanent merchant rule is only
 * ever created by EXPLICIT owner action — never silently learned from a correction.
 * ===========================================================================*/

if (typeof window !== "undefined") {
  throw new Error("categories service is server-only and must not be imported in the browser.");
}

import { and, eq, inArray, isNull, ne, sql, desc } from "drizzle-orm";
import { db } from "@/db";
import {
  importedTransactions, transactionCategories, transactionCategoryAssignments,
  merchantCategoryRules, financialEventEvidence,
} from "@/db/schema";

export class CategoryError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.name = "CategoryError"; this.status = status; }
}

const num = (s: string | null | undefined) => (s == null ? 0 : Number(s));
export const MIN_SUGGESTION_SCORE = 50; // documented minimum to persist/display
export const BANDS = { high: 85, medium: 65 } as const; // high ≥85, medium 65–84, low <65
const band = (n: number): "high" | "medium" | "low" => (n >= BANDS.high ? "high" : n >= BANDS.medium ? "medium" : "low");

/* ---------------------------------------------------- normalization ------- */
/**
 * Deterministic merchant normalization (Xanther-owned metadata; the original
 * merchant/description is never changed). Rules, conservative on purpose:
 *   1. lowercase + trim + collapse repeated whitespace;
 *   2. replace card/store markers (`#`, `*`) and harmless punctuation
 *      (`. , ' " ( )`) with a space;
 *   3. strip ONE trailing pure-digit run (a store/transaction number, optionally
 *      after `#`) ONLY when the remaining base still has ≥3 letters — so
 *      `STARBUCKS 12345`, `Starbucks #12345`, and `STARBUCKS` all → `starbucks`,
 *      while a short/ambiguous base is left intact.
 * It never aggressively folds unrelated merchants together.
 */
export function normalizeMerchant(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw.toLowerCase().trim();
  s = s.replace(/[#*]/g, " ").replace(/[.,'"()]/g, " ").replace(/\s+/g, " ").trim();
  const m = s.match(/^(.*?)\s+\d{2,}$/);
  if (m && m[1].replace(/[^a-z]/g, "").length >= 3) s = m[1].trim();
  return s.replace(/\s+/g, " ").trim();
}

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "category";
}

/* ------------------------------------------------------- categories ------- */
export const DEFAULT_CATEGORIES: { name: string; kind: "expense" | "income" | "transfer" | "neutral" }[] = [
  { name: "Housing", kind: "expense" }, { name: "Utilities", kind: "expense" }, { name: "Groceries", kind: "expense" },
  { name: "Dining & Coffee", kind: "expense" }, { name: "Transportation", kind: "expense" }, { name: "Car Payment", kind: "expense" },
  { name: "Gas", kind: "expense" }, { name: "Insurance", kind: "expense" }, { name: "Healthcare", kind: "expense" },
  { name: "Shopping", kind: "expense" }, { name: "Entertainment", kind: "expense" }, { name: "Subscriptions", kind: "expense" },
  { name: "Personal Care", kind: "expense" }, { name: "Travel", kind: "expense" }, { name: "Education", kind: "expense" },
  { name: "Gifts & Donations", kind: "expense" }, { name: "Fees & Interest", kind: "expense" },
  { name: "Income", kind: "income" }, { name: "Transfers", kind: "transfer" }, { name: "Uncategorized", kind: "neutral" },
];
export const UNCATEGORIZED_SLUG = "uncategorized";

/** Idempotently create any missing default categories for the owner. Never
 * overwrites a renamed or disabled category (conflict on slug → do nothing). */
export async function ensureDefaultCategories(userId: number): Promise<void> {
  await db.insert(transactionCategories).values(
    DEFAULT_CATEGORIES.map((c, i) => ({ userId, name: c.name, slug: slugify(c.name), kind: c.kind, isSystem: true, isActive: true, sortOrder: i })),
  ).onConflictDoNothing({ target: [transactionCategories.userId, transactionCategories.slug] });
}

export interface CategoryView { id: number; name: string; slug: string; kind: string; isSystem: boolean; isActive: boolean; sortOrder: number; }
const toCategoryView = (r: typeof transactionCategories.$inferSelect): CategoryView => ({ id: r.id, name: r.name, slug: r.slug, kind: r.kind, isSystem: r.isSystem, isActive: r.isActive, sortOrder: r.sortOrder });

export async function listCategories(userId: number, opts: { includeInactive?: boolean } = {}): Promise<CategoryView[]> {
  await ensureDefaultCategories(userId);
  const rows = await db.select().from(transactionCategories).where(and(eq(transactionCategories.userId, userId), isNull(transactionCategories.deletedAt))).orderBy(transactionCategories.sortOrder, transactionCategories.name);
  return rows.filter((r) => opts.includeInactive || r.isActive).map(toCategoryView);
}

async function getOwnedCategory(userId: number, id: number, mustBeActive = false) {
  const [c] = await db.select().from(transactionCategories).where(and(eq(transactionCategories.id, id), eq(transactionCategories.userId, userId), isNull(transactionCategories.deletedAt)));
  if (!c) throw new CategoryError(404, "Category not found.");
  if (mustBeActive && !c.isActive) throw new CategoryError(400, "That category is inactive.");
  return c;
}

export async function createCategory(userId: number, input: { name: string; kind?: "expense" | "income" | "transfer" | "neutral" }): Promise<CategoryView> {
  const name = String(input.name ?? "").trim();
  if (!name) throw new CategoryError(400, "A category name is required.");
  await ensureDefaultCategories(userId);
  const active = await db.select().from(transactionCategories).where(and(eq(transactionCategories.userId, userId), eq(transactionCategories.isActive, true), isNull(transactionCategories.deletedAt)));
  if (active.some((c) => c.name.toLowerCase() === name.toLowerCase())) throw new CategoryError(409, "A category with that name already exists.");
  const slug = slugify(name);
  const maxSort = active.reduce((m, c) => Math.max(m, c.sortOrder), 0);
  try {
    const [c] = await db.insert(transactionCategories).values({ userId, name, slug, kind: input.kind ?? "expense", isSystem: false, isActive: true, sortOrder: maxSort + 1 }).returning();
    return toCategoryView(c);
  } catch { throw new CategoryError(409, "A category with that name already exists."); }
}

export async function updateCategory(userId: number, id: number, patch: { name?: string; sortOrder?: number; isActive?: boolean }): Promise<CategoryView> {
  const cat = await getOwnedCategory(userId, id);
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name != null) {
    const name = String(patch.name).trim();
    if (!name) throw new CategoryError(400, "A category name is required.");
    if (cat.slug === UNCATEGORIZED_SLUG && name.toLowerCase() !== "uncategorized") throw new CategoryError(400, "The Uncategorized category cannot be renamed.");
    const active = await db.select().from(transactionCategories).where(and(eq(transactionCategories.userId, userId), eq(transactionCategories.isActive, true), isNull(transactionCategories.deletedAt), ne(transactionCategories.id, id)));
    if (active.some((c) => c.name.toLowerCase() === name.toLowerCase())) throw new CategoryError(409, "A category with that name already exists.");
    set.name = name;
  }
  if (patch.sortOrder != null) set.sortOrder = patch.sortOrder;
  if (patch.isActive === false) {
    if (cat.slug === UNCATEGORIZED_SLUG) throw new CategoryError(400, "The Uncategorized category cannot be deactivated.");
    // Safe fallback: never orphan active assignments — block deactivation while in use.
    const inUse = await db.select({ id: transactionCategoryAssignments.id }).from(transactionCategoryAssignments).where(and(eq(transactionCategoryAssignments.userId, userId), eq(transactionCategoryAssignments.categoryId, id), inArray(transactionCategoryAssignments.status, ["confirmed", "suggested"])));
    if (inUse.length) throw new CategoryError(409, "Reassign its transactions before deactivating this category.");
    set.isActive = false;
  } else if (patch.isActive === true) set.isActive = true;
  const [c] = await db.update(transactionCategories).set(set).where(and(eq(transactionCategories.id, id), eq(transactionCategories.userId, userId))).returning();
  return toCategoryView(c);
}

/* -------------------------------------------------- suggestion engine ----- */
const SCORES: Record<string, number> = { exact_merchant_rule: 90, confirmed_transfer_evidence: 85, prior_owner_confirmation: 80, description_rule: 75, inflow_direction: 70, provider_category_hint: 55 };

type Rule = typeof merchantCategoryRules.$inferSelect;
/** Deterministic winning rule for a transaction. Precedence: exact normalized
 * merchant > broader description rule; within a rank, higher priority then older
 * (lower id) wins — stable across runs. */
function winningRule(rules: Rule[], normMerchant: string, descLower: string): Rule | null {
  const matches = rules.filter((r) => {
    if (!r.isActive) return false;
    if (r.matchType === "exact_normalized_merchant") return normMerchant !== "" && r.normalizedMatchValue === normMerchant;
    if (r.matchType === "description_contains") return r.normalizedMatchValue !== "" && descLower.includes(r.normalizedMatchValue);
    if (r.matchType === "description_starts_with") return r.normalizedMatchValue !== "" && descLower.startsWith(r.normalizedMatchValue);
    return false;
  });
  if (!matches.length) return null;
  const rank = (r: Rule) => (r.matchType === "exact_normalized_merchant" ? 0 : 1);
  matches.sort((a, b) => rank(a) - rank(b) || b.priority - a.priority || a.id - b.id);
  return matches[0];
}

interface Signal { categoryId: number; source: "merchant_rule" | "deterministic_suggestion"; behavior: "suggest" | "auto"; ruleId: number | null; score: number; reasonCodes: string[]; }

export interface GenerateResult { evaluated: number; suggested: number; autoConfirmed: number; }

/**
 * Deterministically (re)generate category suggestions for eligible transactions
 * (active, not removed, with NO confirmed assignment). An owner-confirmed
 * assignment is never touched. A rejected identical (txn+category) suggestion is
 * not silently reopened. Auto merchant rules produce a CONFIRMED assignment;
 * everything else produces a SUGGESTED assignment. Idempotent: one current
 * suggested + one current confirmed per transaction (DB partial-unique enforced).
 */
export async function generateCategorySuggestions(userId: number): Promise<GenerateResult> {
  await ensureDefaultCategories(userId);
  const cats = await db.select().from(transactionCategories).where(and(eq(transactionCategories.userId, userId), isNull(transactionCategories.deletedAt)));
  const catBySlug = new Map(cats.map((c) => [c.slug, c]));
  const activeCatIds = new Set(cats.filter((c) => c.isActive).map((c) => c.id));
  const rules = await db.select().from(merchantCategoryRules).where(and(eq(merchantCategoryRules.userId, userId), isNull(merchantCategoryRules.deletedAt)));

  const txns = await db.select().from(importedTransactions).where(and(eq(importedTransactions.userId, userId), isNull(importedTransactions.deletedAt)));
  const active = txns.filter((t) => t.status === "active");
  const assigns = await db.select().from(transactionCategoryAssignments).where(eq(transactionCategoryAssignments.userId, userId));
  const confirmedTxn = new Set(assigns.filter((a) => a.status === "confirmed").map((a) => a.transactionId));
  const rejectedPair = new Set(assigns.filter((a) => a.status === "rejected").map((a) => `${a.transactionId}:${a.categoryId}`));
  const curSuggested = new Map(assigns.filter((a) => a.status === "suggested").map((a) => [a.transactionId, a]));
  // prior owner-confirmed category by normalized merchant (for "prior_owner_confirmation").
  const txnById = new Map(txns.map((t) => [t.id, t]));
  const priorByMerchant = new Map<string, number>();
  for (const a of assigns) {
    if (a.status !== "confirmed" || a.source !== "owner") continue;
    const t = txnById.get(a.transactionId); if (!t) continue;
    const nm = normalizeMerchant(t.merchantName ?? t.descriptionCurrent);
    if (nm) priorByMerchant.set(nm, a.categoryId);
  }
  const transferEvTxn = new Set((await db.select().from(financialEventEvidence).where(and(eq(financialEventEvidence.userId, userId), eq(financialEventEvidence.eventType, "transfer")))).flatMap((e) => [e.primaryTransactionId, e.secondaryTransactionId].filter((x): x is number => x != null)));

  const res: GenerateResult = { evaluated: 0, suggested: 0, autoConfirmed: 0 };
  for (const t of active) {
    if (confirmedTxn.has(t.id)) continue; // never override a confirmed assignment
    res.evaluated++;
    const nm = normalizeMerchant(t.merchantName ?? t.descriptionCurrent);
    const descLower = (t.descriptionCurrent ?? "").toLowerCase();
    let signal: Signal | null = null;
    const rule = winningRule(rules, nm, descLower);
    if (rule && activeCatIds.has(rule.categoryId)) {
      signal = { categoryId: rule.categoryId, source: "merchant_rule", behavior: rule.behavior, ruleId: rule.id, score: rule.matchType === "exact_normalized_merchant" ? SCORES.exact_merchant_rule : SCORES.description_rule, reasonCodes: [rule.matchType === "exact_normalized_merchant" ? "exact_merchant_rule" : "description_rule"] };
    } else if (nm && priorByMerchant.has(nm) && activeCatIds.has(priorByMerchant.get(nm)!)) {
      signal = { categoryId: priorByMerchant.get(nm)!, source: "deterministic_suggestion", behavior: "suggest", ruleId: null, score: SCORES.prior_owner_confirmation, reasonCodes: ["prior_owner_confirmation", "merchant_name_match"] };
    } else if (transferEvTxn.has(t.id) && catBySlug.get("transfers")?.isActive) {
      signal = { categoryId: catBySlug.get("transfers")!.id, source: "deterministic_suggestion", behavior: "suggest", ruleId: null, score: SCORES.confirmed_transfer_evidence, reasonCodes: ["confirmed_transfer_evidence"] };
    } else if (num(t.amount) > 0 && catBySlug.get("income")?.isActive) {
      signal = { categoryId: catBySlug.get("income")!.id, source: "deterministic_suggestion", behavior: "suggest", ruleId: null, score: SCORES.inflow_direction, reasonCodes: ["inflow_direction"] };
    } else if (t.categoryPrimary && catBySlug.get("shopping")?.isActive && /shop|store|retail|merch/i.test(t.categoryPrimary)) {
      signal = { categoryId: catBySlug.get("shopping")!.id, source: "deterministic_suggestion", behavior: "suggest", ruleId: null, score: SCORES.provider_category_hint, reasonCodes: ["provider_category_hint"] };
    }
    if (!signal || signal.score < MIN_SUGGESTION_SCORE) continue;
    if (rejectedPair.has(`${t.id}:${signal.categoryId}`)) continue; // do not reopen a rejected identical suggestion

    if (signal.behavior === "auto") {
      // Auto rule → confirmed merchant_rule assignment (only for not-yet-confirmed txns).
      const sug = curSuggested.get(t.id);
      if (sug) await db.update(transactionCategoryAssignments).set({ status: "superseded", updatedAt: new Date() }).where(eq(transactionCategoryAssignments.id, sug.id)).catch(() => {});
      const ins = await db.insert(transactionCategoryAssignments).values({ userId, transactionId: t.id, categoryId: signal.categoryId, source: "merchant_rule", status: "confirmed", ruleId: signal.ruleId, confidence: signal.score, reasonCodes: JSON.stringify(signal.reasonCodes), reviewedAt: new Date() }).onConflictDoNothing({ target: transactionCategoryAssignments.transactionId, where: sql`status = 'confirmed'` }).returning({ id: transactionCategoryAssignments.id }).catch(() => [] as { id: number }[]);
      if (ins.length) { res.autoConfirmed++; confirmedTxn.add(t.id); }
      continue;
    }
    // Suggest behavior → current suggested assignment.
    const sug = curSuggested.get(t.id);
    if (sug) {
      if (sug.categoryId === signal.categoryId) { await db.update(transactionCategoryAssignments).set({ confidence: signal.score, reasonCodes: JSON.stringify(signal.reasonCodes), source: signal.source, ruleId: signal.ruleId, updatedAt: new Date() }).where(eq(transactionCategoryAssignments.id, sug.id)); res.suggested++; continue; }
      await db.update(transactionCategoryAssignments).set({ status: "superseded", updatedAt: new Date() }).where(eq(transactionCategoryAssignments.id, sug.id)).catch(() => {});
    }
    const ins = await db.insert(transactionCategoryAssignments).values({ userId, transactionId: t.id, categoryId: signal.categoryId, source: signal.source, status: "suggested", ruleId: signal.ruleId, confidence: signal.score, reasonCodes: JSON.stringify(signal.reasonCodes) }).onConflictDoNothing({ target: transactionCategoryAssignments.transactionId, where: sql`status = 'suggested'` }).returning({ id: transactionCategoryAssignments.id }).catch(() => [] as { id: number }[]);
    if (ins.length) res.suggested++;
  }
  return res;
}

/* --------------------------------------------------------- views ---------- */
export interface TxnCategoryView {
  transactionId: number; amount: number; date: string | null; description: string; accountLabel: string; isPending: boolean; status: string;
  category: { id: number; name: string; kind: string } | null;
  categorySource: "owner" | "merchant_rule" | "deterministic_suggestion" | null;
  categoryStatus: "suggested" | "confirmed" | null;
  confidence: number | null; confidenceBand: "high" | "medium" | "low" | null; reasonCodes: string[]; explanation: string | null;
}
function explainCat(reasons: string[]): string {
  if (reasons.includes("exact_merchant_rule")) return "Matches your merchant rule";
  if (reasons.includes("description_rule")) return "Matches your description rule";
  if (reasons.includes("prior_owner_confirmation")) return "You categorized this merchant before";
  if (reasons.includes("confirmed_transfer_evidence")) return "Confirmed as a transfer";
  if (reasons.includes("inflow_direction")) return "Money came in (likely income)";
  if (reasons.includes("provider_category_hint")) return "Based on the bank's category hint";
  return "Suggested category";
}

/** The current category state for a set of transactions (for Imported Activity).
 * Confirmed wins over suggested. */
export async function getTransactionCategoryMap(userId: number, txnIds: number[]): Promise<Map<number, TxnCategoryView["category"] & { source: string; status: string } | null>> {
  const map = new Map<number, any>();
  if (!txnIds.length) return map;
  const rows = await db.select().from(transactionCategoryAssignments).where(and(eq(transactionCategoryAssignments.userId, userId), inArray(transactionCategoryAssignments.transactionId, txnIds), inArray(transactionCategoryAssignments.status, ["confirmed", "suggested"])));
  const cats = new Map((await db.select().from(transactionCategories).where(eq(transactionCategories.userId, userId))).map((c) => [c.id, c]));
  for (const id of txnIds) {
    const forTxn = rows.filter((r) => r.transactionId === id);
    const a = forTxn.find((r) => r.status === "confirmed") ?? forTxn.find((r) => r.status === "suggested");
    if (!a) { map.set(id, null); continue; }
    const c = cats.get(a.categoryId);
    map.set(id, c ? { id: c.id, name: c.name, kind: c.kind, source: a.source, status: a.status } : null);
  }
  return map;
}

/** The Categorize-transactions review queue: uncategorized + suggested active
 * transactions, newest posted first, bounded; removed excluded. */
export async function getCategoryReviewQueue(userId: number, opts: { limit?: number; filter?: string; categoryId?: number } = {}): Promise<TxnCategoryView[]> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const txns = (await db.select().from(importedTransactions).where(and(eq(importedTransactions.userId, userId), isNull(importedTransactions.deletedAt), eq(importedTransactions.status, "active")))).sort((a, b) => (b.postedDate ?? "").localeCompare(a.postedDate ?? "") || b.id - a.id);
  const assigns = await db.select().from(transactionCategoryAssignments).where(and(eq(transactionCategoryAssignments.userId, userId), inArray(transactionCategoryAssignments.status, ["confirmed", "suggested"])));
  const cats = new Map((await db.select().from(transactionCategories).where(eq(transactionCategories.userId, userId))).map((c) => [c.id, c]));
  const acctRows = await db.execute(sql`SELECT id, name FROM financial_accounts WHERE user_id = ${userId}`);
  const acctName = new Map((acctRows.rows as { id: number; name: string }[]).map((r) => [r.id, r.name]));

  const views: TxnCategoryView[] = txns.map((t) => {
    const a = assigns.find((x) => x.transactionId === t.id && x.status === "confirmed") ?? assigns.find((x) => x.transactionId === t.id && x.status === "suggested");
    const c = a ? cats.get(a.categoryId) : undefined;
    const reasons = a ? (JSON.parse(a.reasonCodes) as string[]) : [];
    return {
      transactionId: t.id, amount: num(t.amount), date: t.postedDate, description: t.merchantName ?? t.descriptionCurrent, accountLabel: t.financialAccountId != null ? (acctName.get(t.financialAccountId) ?? "Linked account") : "Not added to Xanther", isPending: t.isPending, status: t.status,
      category: c ? { id: c.id, name: c.name, kind: c.kind } : null,
      categorySource: a?.source ?? null, categoryStatus: (a?.status as "suggested" | "confirmed") ?? null,
      confidence: a?.confidence ?? null, confidenceBand: a?.confidence != null ? band(a.confidence) : null, reasonCodes: reasons, explanation: a && a.status === "suggested" ? explainCat(reasons) : null,
    };
  });

  let filtered = views;
  if (opts.filter === "uncategorized") filtered = views.filter((v) => v.category == null);
  else if (opts.filter === "suggested") filtered = views.filter((v) => v.categoryStatus === "suggested");
  else if (opts.filter === "confirmed") filtered = views.filter((v) => v.categoryStatus === "confirmed");
  else if (opts.filter === "review") filtered = views.filter((v) => v.category == null || v.categoryStatus === "suggested");
  else if (opts.categoryId) filtered = views.filter((v) => v.category?.id === opts.categoryId);
  return filtered.slice(0, limit);
}

export async function countUncategorized(userId: number): Promise<number> {
  const active = await db.select({ id: importedTransactions.id }).from(importedTransactions).where(and(eq(importedTransactions.userId, userId), isNull(importedTransactions.deletedAt), eq(importedTransactions.status, "active")));
  if (!active.length) return 0;
  const confirmedOrSuggested = new Set((await db.select({ t: transactionCategoryAssignments.transactionId }).from(transactionCategoryAssignments).where(and(eq(transactionCategoryAssignments.userId, userId), inArray(transactionCategoryAssignments.status, ["confirmed", "suggested"])))).map((r) => r.t));
  return active.filter((t) => !confirmedOrSuggested.has(t.id)).length;
}

export async function categorySummary(userId: number): Promise<{ categorized: number; uncategorized: number; needsReview: number }> {
  const active = await db.select({ id: importedTransactions.id }).from(importedTransactions).where(and(eq(importedTransactions.userId, userId), isNull(importedTransactions.deletedAt), eq(importedTransactions.status, "active")));
  const ass = await db.select({ t: transactionCategoryAssignments.transactionId, s: transactionCategoryAssignments.status }).from(transactionCategoryAssignments).where(and(eq(transactionCategoryAssignments.userId, userId), inArray(transactionCategoryAssignments.status, ["confirmed", "suggested"])));
  const confirmed = new Set(ass.filter((a) => a.s === "confirmed").map((a) => a.t));
  const suggested = new Set(ass.filter((a) => a.s === "suggested").map((a) => a.t));
  let categorized = 0, uncategorized = 0, needsReview = 0;
  for (const t of active) { if (confirmed.has(t.id)) categorized++; else if (suggested.has(t.id)) needsReview++; else uncategorized++; }
  return { categorized, uncategorized, needsReview };
}

/* ----------------------------------------------- confirm / reject --------- */
export async function confirmCategoryAssignment(userId: number, transactionId: number, categoryId: number, opts?: { createRule?: { behavior: "suggest" | "auto"; applyToExisting?: boolean } }): Promise<{ ok: true; ruleId: number | null }> {
  const [t] = await db.select().from(importedTransactions).where(and(eq(importedTransactions.id, transactionId), eq(importedTransactions.userId, userId), isNull(importedTransactions.deletedAt)));
  if (!t) throw new CategoryError(404, "Transaction not found.");
  if (t.status === "removed") throw new CategoryError(409, "A removed transaction cannot receive a new category.");
  await getOwnedCategory(userId, categoryId, true);

  const current = await db.select().from(transactionCategoryAssignments).where(and(eq(transactionCategoryAssignments.userId, userId), eq(transactionCategoryAssignments.transactionId, transactionId), inArray(transactionCategoryAssignments.status, ["confirmed", "suggested"])));
  const confirmed = current.find((a) => a.status === "confirmed");
  if (confirmed && confirmed.categoryId === categoryId) {
    // idempotent: already confirmed to this category. Clear any stale suggestion.
    const sug = current.find((a) => a.status === "suggested");
    if (sug) await db.update(transactionCategoryAssignments).set({ status: "superseded", updatedAt: new Date() }).where(eq(transactionCategoryAssignments.id, sug.id));
    return { ok: true, ruleId: await maybeCreateRule(userId, t, categoryId, opts) };
  }
  // Supersede the prior confirmed (history preserved) + any suggested.
  for (const a of current) await db.update(transactionCategoryAssignments).set({ status: "superseded", updatedAt: new Date() }).where(eq(transactionCategoryAssignments.id, a.id));
  // Insert the new confirmed owner assignment (partial-unique backstops concurrency).
  const ins = await db.insert(transactionCategoryAssignments).values({ userId, transactionId, categoryId, source: "owner", status: "confirmed", reasonCodes: "[]", reviewedAt: new Date() }).onConflictDoNothing({ target: transactionCategoryAssignments.transactionId, where: sql`status = 'confirmed'` }).returning({ id: transactionCategoryAssignments.id });
  if (!ins.length) {
    // Lost a concurrent race — confirm whichever current confirmed exists; idempotent.
    const again = await db.select().from(transactionCategoryAssignments).where(and(eq(transactionCategoryAssignments.userId, userId), eq(transactionCategoryAssignments.transactionId, transactionId), eq(transactionCategoryAssignments.status, "confirmed")));
    if (!again.length) throw new CategoryError(500, "Could not confirm the category.");
  }
  return { ok: true, ruleId: await maybeCreateRule(userId, t, categoryId, opts) };
}

async function maybeCreateRule(userId: number, t: typeof importedTransactions.$inferSelect, categoryId: number, opts?: { createRule?: { behavior: "suggest" | "auto"; applyToExisting?: boolean } }): Promise<number | null> {
  if (!opts?.createRule) return null; // a correction alone NEVER creates a rule
  const matchValue = (t.merchantName ?? t.descriptionCurrent ?? "").trim();
  const rule = await createRule(userId, { matchValue, matchType: "exact_normalized_merchant", categoryId, behavior: opts.createRule.behavior, applyToExisting: opts.createRule.applyToExisting, createdFromTransactionId: t.id });
  return rule.id;
}

export async function rejectCategorySuggestion(userId: number, transactionId: number): Promise<{ ok: true }> {
  const [t] = await db.select({ id: importedTransactions.id }).from(importedTransactions).where(and(eq(importedTransactions.id, transactionId), eq(importedTransactions.userId, userId)));
  if (!t) throw new CategoryError(404, "Transaction not found.");
  const [sug] = await db.select().from(transactionCategoryAssignments).where(and(eq(transactionCategoryAssignments.userId, userId), eq(transactionCategoryAssignments.transactionId, transactionId), eq(transactionCategoryAssignments.status, "suggested")));
  if (sug) await db.update(transactionCategoryAssignments).set({ status: "rejected", reviewedAt: new Date(), updatedAt: new Date() }).where(eq(transactionCategoryAssignments.id, sug.id));
  return { ok: true };
}

/* ------------------------------------------------------ merchant rules ---- */
export interface RuleView { id: number; name: string; matchType: string; matchValue: string; categoryId: number; categoryName: string; behavior: string; priority: number; isActive: boolean; affects: number; }

export async function listRules(userId: number): Promise<RuleView[]> {
  const rules = await db.select().from(merchantCategoryRules).where(and(eq(merchantCategoryRules.userId, userId), isNull(merchantCategoryRules.deletedAt))).orderBy(desc(merchantCategoryRules.isActive), merchantCategoryRules.priority, merchantCategoryRules.id);
  const cats = new Map((await db.select().from(transactionCategories).where(eq(transactionCategories.userId, userId))).map((c) => [c.id, c.name]));
  const counts = await db.select({ ruleId: transactionCategoryAssignments.ruleId, n: sql<number>`count(*)::int` }).from(transactionCategoryAssignments).where(and(eq(transactionCategoryAssignments.userId, userId), inArray(transactionCategoryAssignments.status, ["confirmed", "suggested"]))).groupBy(transactionCategoryAssignments.ruleId);
  const countByRule = new Map(counts.map((c) => [c.ruleId, c.n]));
  return rules.map((r) => ({ id: r.id, name: r.name, matchType: r.matchType, matchValue: r.matchValue, categoryId: r.categoryId, categoryName: cats.get(r.categoryId) ?? "—", behavior: r.behavior, priority: r.priority, isActive: r.isActive, affects: countByRule.get(r.id) ?? 0 }));
}

export async function createRule(userId: number, input: { matchValue: string; matchType?: "exact_normalized_merchant" | "description_contains" | "description_starts_with"; categoryId: number; behavior?: "suggest" | "auto"; priority?: number; applyToExisting?: boolean; createdFromTransactionId?: number }): Promise<{ id: number; appliedToExisting: number }> {
  const matchValue = String(input.matchValue ?? "").trim();
  if (!matchValue) throw new CategoryError(400, "A merchant match value is required.");
  await getOwnedCategory(userId, input.categoryId, true);
  const matchType = input.matchType ?? "exact_normalized_merchant";
  const normalized = matchType === "exact_normalized_merchant" ? normalizeMerchant(matchValue) : matchValue.toLowerCase().trim();
  if (!normalized) throw new CategoryError(400, "The merchant match value is empty after normalization.");
  // Duplicate equivalent ACTIVE rule prevention (case-insensitive via normalization).
  const dup = await db.select({ id: merchantCategoryRules.id }).from(merchantCategoryRules).where(and(eq(merchantCategoryRules.userId, userId), eq(merchantCategoryRules.isActive, true), eq(merchantCategoryRules.matchType, matchType), eq(merchantCategoryRules.normalizedMatchValue, normalized), isNull(merchantCategoryRules.deletedAt)));
  if (dup.length) throw new CategoryError(409, "An equivalent active rule already exists.");
  let rule;
  try {
    [rule] = await db.insert(merchantCategoryRules).values({ userId, name: `${matchValue} → category`, matchType, matchValue, normalizedMatchValue: normalized, categoryId: input.categoryId, behavior: input.behavior ?? "suggest", priority: input.priority ?? 0, isActive: true, applyToExisting: input.applyToExisting ?? false, createdFromTransactionId: input.createdFromTransactionId ?? null }).returning();
  } catch { throw new CategoryError(409, "An equivalent active rule already exists."); }
  let applied = 0;
  if (input.applyToExisting) applied = await applyRuleToExisting(userId, rule.id);
  return { id: rule.id, appliedToExisting: applied };
}

export async function updateRule(userId: number, id: number, patch: { categoryId?: number; behavior?: "suggest" | "auto"; isActive?: boolean; priority?: number }): Promise<{ ok: true }> {
  const [rule] = await db.select().from(merchantCategoryRules).where(and(eq(merchantCategoryRules.id, id), eq(merchantCategoryRules.userId, userId), isNull(merchantCategoryRules.deletedAt)));
  if (!rule) throw new CategoryError(404, "Rule not found.");
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.categoryId != null) { await getOwnedCategory(userId, patch.categoryId, true); set.categoryId = patch.categoryId; }
  if (patch.behavior != null) set.behavior = patch.behavior;
  if (patch.priority != null) set.priority = patch.priority;
  if (patch.isActive != null) set.isActive = patch.isActive;
  await db.update(merchantCategoryRules).set(set).where(and(eq(merchantCategoryRules.id, id), eq(merchantCategoryRules.userId, userId)));
  return { ok: true };
}

export async function deleteRule(userId: number, id: number): Promise<{ ok: true; softDisabled: boolean }> {
  const [rule] = await db.select().from(merchantCategoryRules).where(and(eq(merchantCategoryRules.id, id), eq(merchantCategoryRules.userId, userId), isNull(merchantCategoryRules.deletedAt)));
  if (!rule) throw new CategoryError(404, "Rule not found.");
  const history = await db.select({ id: transactionCategoryAssignments.id }).from(transactionCategoryAssignments).where(and(eq(transactionCategoryAssignments.userId, userId), eq(transactionCategoryAssignments.ruleId, id)));
  if (history.length) {
    // Soft-disable — keep assignment history auditable.
    await db.update(merchantCategoryRules).set({ isActive: false, updatedAt: new Date() }).where(eq(merchantCategoryRules.id, id));
    return { ok: true, softDisabled: true };
  }
  await db.update(merchantCategoryRules).set({ isActive: false, deletedAt: new Date(), updatedAt: new Date() }).where(eq(merchantCategoryRules.id, id));
  return { ok: true, softDisabled: false };
}

/** Apply a rule to existing UNCATEGORIZED eligible transactions only. Bounded +
 * idempotent; never touches confirmed assignments or removed transactions. */
export async function applyRuleToExisting(userId: number, ruleId: number): Promise<number> {
  const [rule] = await db.select().from(merchantCategoryRules).where(and(eq(merchantCategoryRules.id, ruleId), eq(merchantCategoryRules.userId, userId), eq(merchantCategoryRules.isActive, true), isNull(merchantCategoryRules.deletedAt)));
  if (!rule) return 0;
  const cat = (await db.select().from(transactionCategories).where(and(eq(transactionCategories.id, rule.categoryId), eq(transactionCategories.userId, userId))))[0];
  if (!cat || !cat.isActive) return 0;
  const txns = await db.select().from(importedTransactions).where(and(eq(importedTransactions.userId, userId), isNull(importedTransactions.deletedAt), eq(importedTransactions.status, "active")));
  const assigns = await db.select().from(transactionCategoryAssignments).where(eq(transactionCategoryAssignments.userId, userId));
  const confirmedOrSuggested = new Set(assigns.filter((a) => a.status === "confirmed" || a.status === "suggested").map((a) => a.transactionId));
  const rejectedPair = new Set(assigns.filter((a) => a.status === "rejected").map((a) => `${a.transactionId}:${a.categoryId}`));
  let applied = 0;
  for (const t of txns) {
    if (confirmedOrSuggested.has(t.id)) continue; // uncategorized only
    const nm = normalizeMerchant(t.merchantName ?? t.descriptionCurrent);
    const descLower = (t.descriptionCurrent ?? "").toLowerCase();
    const matched = rule.matchType === "exact_normalized_merchant" ? nm !== "" && rule.normalizedMatchValue === nm
      : rule.matchType === "description_contains" ? descLower.includes(rule.normalizedMatchValue)
      : descLower.startsWith(rule.normalizedMatchValue);
    if (!matched) continue;
    if (rule.behavior === "suggest" && rejectedPair.has(`${t.id}:${cat.id}`)) continue;
    const status = rule.behavior === "auto" ? "confirmed" : "suggested";
    const ins = await db.insert(transactionCategoryAssignments).values({ userId, transactionId: t.id, categoryId: cat.id, source: "merchant_rule", status, ruleId: rule.id, confidence: SCORES.exact_merchant_rule, reasonCodes: JSON.stringify(["exact_merchant_rule"]), reviewedAt: status === "confirmed" ? new Date() : null }).onConflictDoNothing({ target: transactionCategoryAssignments.transactionId, where: sql`status = ${status}` }).returning({ id: transactionCategoryAssignments.id }).catch(() => [] as { id: number }[]);
    if (ins.length) { applied++; confirmedOrSuggested.add(t.id); }
  }
  return applied;
}
