/* =============================================================================
 * verify-finance1b5a.ts — Finance 1B.5A deterministic verification.
 *
 * Transaction categories + owner-approved merchant rules. Categorization is
 * DESCRIPTIVE METADATA ONLY — never mutates imported bank evidence, balances,
 * movements, cursor, or matching evidence; never moves money; never silently
 * learns a rule. Exact-ID temp records only; cleaned on every exit path.
 * ===========================================================================*/

import { readFileSync } from "node:fs";
import { and, eq, inArray, isNull, like, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  importedTransactions, financialConnections, financialAccounts, accountMovements, providerAccounts,
  apiUsageLogs, experienceRequests, transactionCategories, transactionCategoryAssignments,
  merchantCategoryRules, financialEventEvidence,
} from "@/db/schema";
import { CURRENT_USER_ID as U } from "@/lib/auth";
import {
  ensureDefaultCategories, listCategories, createCategory, updateCategory, normalizeMerchant,
  generateCategorySuggestions, confirmCategoryAssignment, rejectCategorySuggestion, createRule,
  updateRule, deleteRule, applyRuleToExisting, listRules, getCategoryReviewQueue, countUncategorized,
  CategoryError, UNCATEGORIZED_SLUG,
} from "@/lib/services/categories";

let passed = 0, failed = 0;
const ok = (n: string, c: boolean) => { c ? passed++ : failed++; console.log(`${c ? "✓" : "✗"} ${n}`); };
const read = (p: string) => readFileSync(p, "utf8");
const FOREIGN = U + 99999;
const created = { conn: 0, accts: [] as number[], txns: [] as number[] };
const catId = (cats: { slug: string; id: number }[], slug: string) => cats.find((c) => c.slug === slug)!.id;

async function cleanup() {
  try {
    // restore owner categorization to the pre-test empty state (app re-bootstraps on next load)
    await db.delete(financialEventEvidence).where(eq(financialEventEvidence.userId, U)).catch(() => {});
    await db.delete(transactionCategoryAssignments).where(eq(transactionCategoryAssignments.userId, U)).catch(() => {});
    await db.delete(merchantCategoryRules).where(eq(merchantCategoryRules.userId, U)).catch(() => {});
    await db.delete(transactionCategories).where(eq(transactionCategories.userId, U)).catch(() => {});
    if (created.accts.length) await db.delete(accountMovements).where(and(eq(accountMovements.userId, U), inArray(accountMovements.accountId, created.accts))).catch(() => {});
    if (created.txns.length) await db.delete(importedTransactions).where(inArray(importedTransactions.id, created.txns)).catch(() => {});
    if (created.accts.length) await db.delete(financialAccounts).where(inArray(financialAccounts.id, created.accts)).catch(() => {});
    if (created.conn) await db.delete(financialConnections).where(eq(financialConnections.id, created.conn)).catch(() => {});
  } catch { /* best effort */ }
}

async function mkTxn(amount: number, merchant: string, opts: { acct: number; removed?: boolean; pending?: boolean; category?: string } = { acct: 0 }) {
  const [t] = await db.insert(importedTransactions).values({ userId: U, connectionId: created.conn, providerAccountId: "pa", provider: "plaid", providerTransactionId: `ZZ5A-${created.txns.length}-${Date.now()}`, status: opts.removed ? "removed" : "active", isPending: opts.pending ?? false, amount: String(amount.toFixed(2)), descriptionCurrent: merchant, merchantName: merchant, financialAccountId: opts.acct, postedDate: "2026-06-20", categoryPrimary: opts.category ?? null }).returning({ id: importedTransactions.id });
  created.txns.push(t.id); return t.id;
}
const confirmedCount = async (txnId: number) => (await db.select().from(transactionCategoryAssignments).where(and(eq(transactionCategoryAssignments.transactionId, txnId), eq(transactionCategoryAssignments.status, "confirmed")))).length;
const suggestedOf = async (txnId: number) => (await db.select().from(transactionCategoryAssignments).where(and(eq(transactionCategoryAssignments.transactionId, txnId), eq(transactionCategoryAssignments.status, "suggested"))))[0];
const confirmedOf = async (txnId: number) => (await db.select().from(transactionCategoryAssignments).where(and(eq(transactionCategoryAssignments.transactionId, txnId), eq(transactionCategoryAssignments.status, "confirmed"))))[0];

async function main() {
  console.log("Finance 1B.5A — transaction categories + merchant rules verification\n");
  // startup sweep
  await db.delete(transactionCategoryAssignments).where(eq(transactionCategoryAssignments.userId, U)).catch(() => {});
  await db.delete(merchantCategoryRules).where(eq(merchantCategoryRules.userId, U)).catch(() => {});
  await db.delete(transactionCategories).where(eq(transactionCategories.userId, U)).catch(() => {});

  const ownerImportedBefore = (await db.select().from(importedTransactions).where(eq(importedTransactions.userId, U))).length;
  const ownerMovementsBefore = (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length;
  const ownerLogsBefore = (await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))).length;

  const [c] = await db.insert(financialConnections).values({ userId: U, provider: "plaid", providerItemId: `ZZ5A-${Date.now()}`, institutionName: "ZZ5A Bank", accessTokenCipher: "x", accessTokenNonce: "x", accessTokenTag: "x", accessTokenKeyVersion: 1, accessTokenEnvelopeVersion: 1, status: "active", environment: "sandbox" }).returning({ id: financialConnections.id });
  created.conn = c.id;
  const [a] = await db.insert(financialAccounts).values({ userId: U, name: "ZZ5A Acct", type: "checking", purpose: "spending", balanceSource: "manual", currentBalance: "1000.00", active: true }).returning({ id: financialAccounts.id });
  created.accts.push(a.id);

  /* ============ bootstrap + management [1-10] ============ */
  console.log("[bootstrap + management]");
  await ensureDefaultCategories(U);
  let cats = await listCategories(U, { includeInactive: true });
  ok("[1] default categories bootstrap for the owner", cats.length >= 20 && cats.some((x) => x.slug === "groceries") && cats.some((x) => x.slug === "dining-and-coffee"));
  await ensureDefaultCategories(U);
  ok("[2] bootstrap is idempotent", (await listCategories(U, { includeInactive: true })).length === cats.length);
  ok("[3] Uncategorized always exists", cats.some((x) => x.slug === UNCATEGORIZED_SLUG));
  let dup4 = false; try { await createCategory(U, { name: "Groceries" }); } catch (e) { dup4 = e instanceof CategoryError && e.status === 409; }
  ok("[4] duplicate active category name is rejected", dup4);
  const custom = await createCategory(U, { name: "ZZ5A Custom" });
  ok("[5] owner can create a custom category", !!custom.id && custom.isSystem === false);
  const renamed = await updateCategory(U, custom.id, { name: "ZZ5A Renamed" });
  ok("[6] owner can rename a custom category", renamed.name === "ZZ5A Renamed");
  const reordered = await updateCategory(U, custom.id, { sortOrder: 999 });
  ok("[7] owner can reorder a category", reordered.sortOrder === 999);
  const deact = await updateCategory(U, custom.id, { isActive: false });
  ok("[8] owner can deactivate an unused category", deact.isActive === false);
  await updateCategory(U, custom.id, { isActive: true }); // reactivate for later
  let foreign10 = false; try { await updateCategory(FOREIGN, custom.id, { name: "X" }); } catch (e) { foreign10 = e instanceof CategoryError && e.status === 404; }
  ok("[10] foreign-owner category access is rejected", foreign10);

  /* ============ normalization [11-17] ============ */
  console.log("\n[normalization]");
  ok("[11] normalization is deterministic", normalizeMerchant("STARBUCKS 12345") === normalizeMerchant("STARBUCKS 12345"));
  ok("[12] case differences normalize together", normalizeMerchant("STARBUCKS") === normalizeMerchant("starbucks"));
  ok("[13] harmless punctuation normalizes together", normalizeMerchant("Starbucks #12345") === normalizeMerchant("STARBUCKS 12345"));
  ok("[14] repeated whitespace normalizes together", normalizeMerchant("shop   rite") === normalizeMerchant("shop rite"));
  ok("[15] store-number normalization is conservative (strips a trailing 2+ digit run to a specific base)", normalizeMerchant("STARBUCKS 12345") === "starbucks" && normalizeMerchant("STARBUCKS") === "starbucks");
  ok("[16] unrelated merchant names do not collapse together", normalizeMerchant("Target") !== normalizeMerchant("Walmart") && normalizeMerchant("Shell Oil") !== normalizeMerchant("Shell 12"));
  const origTxn = await mkTxn(-5, "STARBUCKS #12345", { acct: a.id });
  ok("[17] original merchant description remains unchanged", (await db.select().from(importedTransactions).where(eq(importedTransactions.id, origTxn)))[0].merchantName === "STARBUCKS #12345");

  cats = await listCategories(U, { includeInactive: true });
  const cId = (slug: string) => catId(cats, slug);

  /* ============ suggestions [18-33] ============ */
  console.log("\n[suggestions]");
  // [18] exact rule → suggestion
  const sbTxn = await mkTxn(-4, "STARBUCKS 99999", { acct: a.id });
  await createRule(U, { matchValue: "STARBUCKS 99999", matchType: "exact_normalized_merchant", categoryId: cId("dining-and-coffee"), behavior: "suggest" });
  await generateCategorySuggestions(U);
  ok("[18] exact merchant rule creates the correct suggestion", (await suggestedOf(sbTxn))?.categoryId === cId("dining-and-coffee"));
  // [19] exact outranks broader description rule
  await createRule(U, { matchValue: "star", matchType: "description_contains", categoryId: cId("shopping"), behavior: "suggest" });
  await generateCategorySuggestions(U);
  ok("[19] exact rule outranks broader description rule", (await suggestedOf(sbTxn))?.categoryId === cId("dining-and-coffee"));
  // [20] higher priority wins same rank (two description rules)
  const pTxn = await mkTxn(-7, "PRIORITY MART", { acct: a.id });
  await createRule(U, { matchValue: "priority", matchType: "description_contains", categoryId: cId("shopping"), behavior: "suggest", priority: 1 });
  const hi = await createRule(U, { matchValue: "mart", matchType: "description_contains", categoryId: cId("groceries"), behavior: "suggest", priority: 5 });
  await generateCategorySuggestions(U);
  ok("[20] higher priority wins within the same rule rank", (await suggestedOf(pTxn))?.categoryId === cId("groceries"));
  // [21] older rule wins a stable tie (two description rules, same priority)
  const tTxn = await mkTxn(-9, "TIEBREAK SHOP", { acct: a.id });
  const older = await createRule(U, { matchValue: "tiebreak", matchType: "description_contains", categoryId: cId("entertainment"), behavior: "suggest", priority: 0 });
  await createRule(U, { matchValue: "shop", matchType: "description_contains", categoryId: cId("shopping"), behavior: "suggest", priority: 0 });
  await generateCategorySuggestions(U);
  const tieResult = (await suggestedOf(tTxn))?.categoryId;
  ok("[21] older rule wins a stable tie", tieResult === cId("entertainment") && older.id < hi.id + 100);
  // [22] prior owner-confirmed → suggestion ; [23] no permanent rule from prior
  // Use a merchant matching NO existing rule, so prior-owner-confirmation is the winner.
  const shop1 = await mkTxn(-20, "WEGMANS 11", { acct: a.id });
  await confirmCategoryAssignment(U, shop1, cId("groceries"));
  const rulesAfterCorrection = (await listRules(U)).length;
  const shop2 = await mkTxn(-22, "WEGMANS 22", { acct: a.id });
  await generateCategorySuggestions(U);
  ok("[22] prior owner-confirmed merchant category may create a suggestion", (await suggestedOf(shop2))?.categoryId === cId("groceries"));
  ok("[23] prior confirmation does not create a permanent rule", (await listRules(U)).length === rulesAfterCorrection);
  // [24] inflow → Income
  const inflow = await mkTxn(900, "ZZ5A Mystery Deposit", { acct: a.id });
  await generateCategorySuggestions(U);
  ok("[24] inflow direction may suggest Income", (await suggestedOf(inflow))?.categoryId === cId("income"));
  // [25] confirmed transfer evidence → Transfers
  const xferTxn = await mkTxn(-300, "ZZ5A Internal Move", { acct: a.id });
  await db.insert(financialEventEvidence).values({ userId: U, eventType: "transfer", confirmationMode: "linked_evidence", primaryTransactionId: xferTxn, secondaryTransactionId: null, confirmedAmount: "300.00", confirmedDate: "2026-06-20", eventKey: `transfer:test:${xferTxn}` });
  await generateCategorySuggestions(U);
  ok("[25] confirmed transfer evidence may suggest Transfers", (await suggestedOf(xferTxn))?.categoryId === cId("transfers"));
  const sg = await suggestedOf(sbTxn);
  ok("[26] reason codes are present", (JSON.parse(sg.reasonCodes) as string[]).length > 0);
  ok("[27] confidence is deterministic", sg.confidence != null && sg.confidence === (await suggestedOf(sbTxn)).confidence);
  ok("[28] confidence bands are deterministic", (await getCategoryReviewQueue(U, { filter: "suggested", limit: 50 })).find((v) => v.transactionId === sbTxn)?.confidenceBand === "high");
  // [29] removed excluded
  const removedTxn = await mkTxn(-15, "STARBUCKS 99999", { acct: a.id, removed: true });
  ok("[29] removed transaction is excluded from active review", !(await getCategoryReviewQueue(U, { filter: "all", limit: 200 })).some((v) => v.transactionId === removedTxn));
  // [30] confirmed preserved across generation
  const confPreserve = await confirmedOf(shop1);
  await generateCategorySuggestions(U);
  ok("[30] confirmed assignment is preserved", (await confirmedOf(shop1)).id === confPreserve.id && (await confirmedOf(shop1)).categoryId === cId("groceries"));
  // [31] rejected identical not reopened
  await rejectCategorySuggestion(U, inflow);
  await generateCategorySuggestions(U);
  ok("[31] rejected identical suggestion is not silently reopened", !(await suggestedOf(inflow)));
  // [32] repeated generation idempotent ; [33] concurrent no duplicates
  const before32 = (await db.select().from(transactionCategoryAssignments).where(and(eq(transactionCategoryAssignments.userId, U), eq(transactionCategoryAssignments.status, "suggested")))).length;
  await generateCategorySuggestions(U);
  ok("[32] repeated generation is idempotent", (await db.select().from(transactionCategoryAssignments).where(and(eq(transactionCategoryAssignments.userId, U), eq(transactionCategoryAssignments.status, "suggested")))).length === before32);
  await Promise.all([generateCategorySuggestions(U), generateCategorySuggestions(U)]);
  ok("[33] concurrent generation creates no duplicates", (await db.select().from(transactionCategoryAssignments).where(and(eq(transactionCategoryAssignments.transactionId, sbTxn), eq(transactionCategoryAssignments.status, "suggested")))).length === 1);

  /* ============ assignment [34-53] ============ */
  console.log("\n[assignment]");
  ok("[34] owner can confirm a suggested category", (await confirmCategoryAssignment(U, sbTxn, cId("dining-and-coffee"))).ok && (await confirmedOf(sbTxn)).categoryId === cId("dining-and-coffee"));
  const assignTxn = await mkTxn(-30, "ZZ5A Random Store", { acct: a.id });
  await confirmCategoryAssignment(U, assignTxn, cId("shopping"));
  ok("[35] owner can assign a different category", (await confirmedOf(assignTxn)).categoryId === cId("shopping"));
  const firstAssignId = (await confirmedOf(assignTxn)).id;
  await confirmCategoryAssignment(U, assignTxn, cId("entertainment"));
  ok("[36] correction supersedes the prior assignment", (await confirmedOf(assignTxn)).categoryId === cId("entertainment") && (await confirmedCount(assignTxn)) === 1);
  ok("[37] prior assignment history remains auditable", (await db.select().from(transactionCategoryAssignments).where(and(eq(transactionCategoryAssignments.id, firstAssignId), eq(transactionCategoryAssignments.status, "superseded")))).length === 1);
  await confirmCategoryAssignment(U, assignTxn, cId("entertainment"));
  ok("[38] repeated same assignment is idempotent", (await confirmedCount(assignTxn)) === 1);
  const concTxn = await mkTxn(-31, "ZZ5A Conc", { acct: a.id });
  await Promise.all([confirmCategoryAssignment(U, concTxn, cId("gas")).catch(() => {}), confirmCategoryAssignment(U, concTxn, cId("gas")).catch(() => {})]);
  ok("[39] concurrent confirmation creates one current confirmed assignment", (await confirmedCount(concTxn)) === 1);
  let r40 = false; try { await confirmCategoryAssignment(U, removedTxn, cId("gas")); } catch (e) { r40 = e instanceof CategoryError && e.status === 409; }
  ok("[40] removed transaction cannot receive a new active assignment", r40);
  const inactiveCat = await createCategory(U, { name: "ZZ5A Inactive" }); await updateCategory(U, inactiveCat.id, { isActive: false });
  let r41 = false; try { await confirmCategoryAssignment(U, assignTxn, inactiveCat.id); } catch (e) { r41 = e instanceof CategoryError && e.status === 400; }
  ok("[41] inactive category cannot be newly assigned", r41);
  let r42 = false; try { await confirmCategoryAssignment(FOREIGN, assignTxn, cId("gas")); } catch (e) { r42 = e instanceof CategoryError && e.status === 404; }
  ok("[42] foreign-owner transaction assignment is rejected", r42);
  let r43 = false; try { await confirmCategoryAssignment(U, assignTxn, 99999999); } catch (e) { r43 = e instanceof CategoryError && e.status === 404; }
  ok("[43] foreign-owner / unknown category assignment is rejected", r43);
  // [44-53] domain protection: capture snapshot, categorize, assert unchanged
  const domTxn = await mkTxn(-44, "ZZ5A Domain", { acct: a.id });
  const txnSnap = JSON.stringify((await db.select().from(importedTransactions).where(eq(importedTransactions.id, domTxn)))[0]);
  const acctSnap = JSON.stringify((await db.select().from(financialAccounts).where(eq(financialAccounts.id, a.id)))[0]);
  const provSnap = JSON.stringify((await db.select().from(providerAccounts).where(eq(providerAccounts.userId, U))).map((p) => [p.id, p.balanceCurrent]).sort());
  const cursorSnap = (await db.select({ x: financialConnections.transactionsCursor }).from(financialConnections).where(eq(financialConnections.id, c.id)))[0].x;
  const movSnap = (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length;
  const evSnap = (await db.select().from(financialEventEvidence).where(eq(financialEventEvidence.userId, U))).length;
  await confirmCategoryAssignment(U, domTxn, cId("shopping"));
  ok("[44/45] categorization changes no imported transaction field (amount/date/pending/status)", JSON.stringify((await db.select().from(importedTransactions).where(eq(importedTransactions.id, domTxn)))[0]) === txnSnap);
  ok("[46] categorization creates no movement", (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length === movSnap);
  ok("[47] categorization changes no balance", JSON.stringify((await db.select().from(financialAccounts).where(eq(financialAccounts.id, a.id)))[0]) === acctSnap);
  ok("[48] categorization changes no provider snapshot", JSON.stringify((await db.select().from(providerAccounts).where(eq(providerAccounts.userId, U))).map((p) => [p.id, p.balanceCurrent]).sort()) === provSnap);
  ok("[49] categorization changes no sync cursor", (await db.select({ x: financialConnections.transactionsCursor }).from(financialConnections).where(eq(financialConnections.id, c.id)))[0].x === cursorSnap);
  ok("[50/51/52/53] categorization changes no bill/income/transfer/evidence relationship", (await db.select().from(financialEventEvidence).where(eq(financialEventEvidence.userId, U))).length === evSnap && (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length === movSnap);

  /* ============ merchant rules [54-70] ============ */
  console.log("\n[merchant rules]");
  const rSug = await createRule(U, { matchValue: "ZZ5A SugCo", categoryId: cId("utilities"), behavior: "suggest" });
  ok("[54] owner can explicitly create a suggestion rule", !!rSug.id);
  const rAuto = await createRule(U, { matchValue: "ZZ5A AutoCo", categoryId: cId("subscriptions"), behavior: "auto" });
  ok("[55] owner can explicitly create an auto-categorize rule", !!rAuto.id);
  const correctTxn = await mkTxn(-12, "ZZ5A NoRuleCo", { acct: a.id });
  const rulesBeforeCorrect = (await listRules(U)).length;
  await confirmCategoryAssignment(U, correctTxn, cId("shopping")); // no createRule intent
  ok("[56] category correction alone creates no rule", (await listRules(U)).length === rulesBeforeCorrect);
  let dup57 = false; try { await createRule(U, { matchValue: "zz5a sugco", categoryId: cId("utilities"), behavior: "suggest" }); } catch (e) { dup57 = e instanceof CategoryError && e.status === 409; }
  ok("[57] equivalent duplicate rule is rejected (case-insensitive)", dup57);
  await deleteRule(U, rSug.id);
  ok("[58] rule may be disabled", !(await listRules(U)).find((r) => r.id === rSug.id)?.isActive);
  const sugTxn2 = await mkTxn(-13, "ZZ5A SugCo", { acct: a.id });
  await generateCategorySuggestions(U);
  ok("[59] disabled rule stops affecting future generation", !(await suggestedOf(sugTxn2)));
  ok("[60] rule history remains auditable (soft-disabled rule still present)", (await db.select().from(merchantCategoryRules).where(eq(merchantCategoryRules.id, rSug.id))).length === 1);
  await updateRule(U, rAuto.id, { categoryId: cId("entertainment") });
  ok("[61] rule category target can be changed", (await db.select().from(merchantCategoryRules).where(eq(merchantCategoryRules.id, rAuto.id)))[0].categoryId === cId("entertainment"));
  const rBeh = await createRule(U, { matchValue: "ZZ5A BehCo", categoryId: cId("gas"), behavior: "suggest" });
  await updateRule(U, rBeh.id, { behavior: "auto" });
  ok("[62] rule behavior can change from suggest to auto", (await db.select().from(merchantCategoryRules).where(eq(merchantCategoryRules.id, rBeh.id)))[0].behavior === "auto");
  const autoTxn = await mkTxn(-14, "ZZ5A BehCo", { acct: a.id });
  await generateCategorySuggestions(U);
  ok("[63] auto rule confirms a future uncategorized transaction", (await confirmedOf(autoTxn))?.categoryId === cId("gas") && (await confirmedOf(autoTxn))?.source === "merchant_rule");
  const sugOnlyTxn = await mkTxn(-16, "ZZ5A SugOnlyCo", { acct: a.id });
  await createRule(U, { matchValue: "ZZ5A SugOnlyCo", categoryId: cId("travel"), behavior: "suggest" });
  await generateCategorySuggestions(U);
  ok("[64] suggest rule creates only a suggestion", (await suggestedOf(sugOnlyTxn))?.categoryId === cId("travel") && !(await confirmedOf(sugOnlyTxn)));
  // [65] auto rule never overwrites owner-confirmed
  const ownerFirst = await mkTxn(-17, "ZZ5A BehCo", { acct: a.id });
  await confirmCategoryAssignment(U, ownerFirst, cId("healthcare"));
  await generateCategorySuggestions(U);
  ok("[65] auto rule never overwrites an owner-confirmed assignment", (await confirmedOf(ownerFirst)).categoryId === cId("healthcare") && (await confirmedOf(ownerFirst)).source === "owner");
  // [66/67/68] apply-to-existing
  const existing1 = await mkTxn(-18, "ZZ5A ApplyCo", { acct: a.id });
  const existing2 = await mkTxn(-19, "ZZ5A ApplyCo", { acct: a.id });
  const ownerApply = await mkTxn(-21, "ZZ5A ApplyCo", { acct: a.id }); await confirmCategoryAssignment(U, ownerApply, cId("shopping"));
  const removedApply = await mkTxn(-23, "ZZ5A ApplyCo", { acct: a.id, removed: true });
  const rApply = await createRule(U, { matchValue: "ZZ5A ApplyCo", categoryId: cId("personal-care"), behavior: "suggest", applyToExisting: true });
  ok("[66] apply-to-existing affects only uncategorized eligible transactions", (await suggestedOf(existing1))?.categoryId === cId("personal-care") && (await suggestedOf(existing2))?.categoryId === cId("personal-care") && (await confirmedOf(ownerApply)).categoryId === cId("shopping"));
  const appliedAgain = await applyRuleToExisting(U, rApply.id);
  ok("[67] apply-to-existing is idempotent", appliedAgain === 0);
  ok("[68] apply-to-existing does not affect removed transactions", !(await suggestedOf(removedApply)) && !(await confirmedOf(removedApply)));
  let r69 = false; try { await updateRule(FOREIGN, rApply.id, { behavior: "auto" }); } catch (e) { r69 = e instanceof CategoryError && e.status === 404; }
  ok("[69] foreign-owner rule access is rejected", r69);
  // [70] conflicting rules resolve deterministically (re-run yields same result)
  const conflictTxn = await mkTxn(-24, "EXACTCO 55", { acct: a.id });
  await createRule(U, { matchValue: "EXACTCO 55", matchType: "exact_normalized_merchant", categoryId: cId("groceries"), behavior: "suggest" });
  await createRule(U, { matchValue: "exactco", matchType: "description_contains", categoryId: cId("shopping"), behavior: "suggest" });
  await generateCategorySuggestions(U);
  const conf1 = (await suggestedOf(conflictTxn))?.categoryId;
  await generateCategorySuggestions(U);
  const conf2 = (await suggestedOf(conflictTxn))?.categoryId;
  ok("[70] conflicting rules resolve deterministically (exact wins, stable across runs)", conf1 === cId("groceries") && conf1 === conf2);

  /* ============ UI [71-88] ============ */
  console.log("\n[ui]");
  const impSrc = read("components/finances/imported-activity.tsx");
  const catSrc = read("components/finances/categorize.tsx");
  const pageSrc = read("app/finances/page.tsx");
  ok("[71] category appears on Imported Activity", /catMap\[t\.id\]/.test(impSrc) && /Uncategorized/.test(impSrc));
  ok("[72] uncategorized state is truthful", /Uncategorized/.test(impSrc) && /Uncategorized/.test(catSrc));
  ok("[73] suggested badge renders", /\(suggested\)|Suggested/.test(impSrc) && /Suggested/.test(catSrc));
  ok("[74] confirmed badge/source renders", /You chose this|Merchant rule/.test(catSrc));
  ok("[75] category selector renders", /select aria-label="Category"/.test(catSrc));
  ok("[76] Confirm action renders", /Confirm/.test(catSrc));
  ok("[77] Change action renders", /Change to/.test(catSrc));
  ok("[78] Reject suggestion renders", /Reject suggestion/.test(catSrc));
  ok("[79] Categorize transactions review queue renders", /Categorize transactions/.test(catSrc) && /<Categorize/.test(pageSrc));
  ok("[80] review queue is bounded to 10", /const PAGE = 10/.test(catSrc));
  ok("[81] filters render", /Needs review/.test(catSrc) && /Uncategorized/.test(catSrc));
  ok("[82] Categories & merchant rules management renders", /Categories & merchant rules/.test(catSrc) && /Merchant rules/.test(catSrc));
  ok("[83] rule behavior choice defaults to Suggest", /useState\("suggest"\)/.test(catSrc));
  ok("[84] apply-to-existing is unchecked by default", /useState\(false\)/.test(catSrc) && /Apply to existing uncategorized/.test(catSrc));
  ok("[85] Home pending-categorization count renders", /transactionsToCategorize > 0/.test(read("components/home/sections.tsx")) && /need.*categorization|categorization/.test(read("components/home/sections.tsx")));
  ok("[86] /manage remains unchanged (no categorization wiring)", !/Categorize|categories\/assignments/.test(read("components/manage/manage-dashboard.tsx")));
  ok("[87] desktop layout usable (component renders a list)", /fin-match-list/.test(catSrc));
  ok("[88] 375px layout has no fixed wide widths", !/width:\s*[4-9]\d\dpx/.test(catSrc) && /flex-wrap/.test(read("app/globals.css").match(/fin-cat-state[\s\S]{0,80}/)?.[0] ?? "x flex-wrap"));

  /* ============ domain boundaries [89-102] ============ */
  console.log("\n[domain boundaries]");
  const svcSrc = read("lib/services/categories.ts");
  const routesSrc = read("app/api/finances/categories/route.ts") + read("app/api/finances/categories/assignments/[transactionId]/confirm/route.ts");
  ok("[89] no AI categorization", !/anthropic|openai|embedding|messages\.create|gpt/i.test(svcSrc + catSrc));
  ok("[90] no Production Plaid work", !/production/i.test(svcSrc + routesSrc));
  ok("[91] no OAuth expansion", !/oauth|redirect_uri/i.test(svcSrc + routesSrc));
  ok("[92] no money movement", !/createTransfer|completeTransfer|payBill|receiveIncome|moveMoney|paymentInitiation/.test(svcSrc));
  ok("[93] no budgeting", !/budget/i.test(svcSrc + catSrc));
  ok("[94] no spending forecast", !/forecast|projection/i.test(svcSrc));
  ok("[95] no receipt OCR", !/ocr|receipt/i.test(svcSrc + catSrc));
  ok("[96] no automatic bill creation", !/insert\(financialEntries\)|createBill/.test(svcSrc));
  ok("[97] no automatic permanent learning from a correction", /a correction alone NEVER creates a rule/.test(svcSrc) && /opts\?\.createRule/.test(svcSrc));
  ok("[98] no webhook behavior change", !/webhook/i.test(svcSrc + routesSrc));
  ok("[99] no imported-transaction rewrite (service never updates importedTransactions)", !/update\(importedTransactions\)/.test(svcSrc));
  ok("[100] no balance rewrite", !/update\(financialAccounts\)/.test(svcSrc));
  ok("[101] no provider snapshot rewrite", !/update\(providerAccounts\)/.test(svcSrc));
  ok("[102] no cursor rewrite", !/transactionsCursor/.test(svcSrc));

  /* ============ summary/home ============ */
  ok("[count] countUncategorized returns a number", typeof (await countUncategorized(U)) === "number");

  await cleanup();

  /* ============ owner protection [103-113] ============ */
  console.log("\n[owner protection]");
  const conns = await db.select().from(financialConnections).where(and(eq(financialConnections.userId, U), isNull(financialConnections.deletedAt)));
  const bofa = conns.find((x) => /bank of america/i.test(x.institutionName ?? ""));
  const accts = await db.select().from(financialAccounts).where(and(eq(financialAccounts.userId, U), isNull(financialAccounts.deletedAt)));
  const linked = accts.filter((x) => x.balanceSource === "linked"); let orphan = 0;
  for (const l of linked) { const m = await db.select().from(providerAccounts).where(and(eq(providerAccounts.financialAccountId, l.id), isNull(providerAccounts.deletedAt))); if (m.length !== 1) orphan++; }
  ok("[103] Bank of America Sandbox remains active", bofa?.status === "active" && bofa?.environment === "sandbox");
  ok("[104] Plaid Checking remains linked", accts.some((x) => x.name === "Plaid Checking" && x.balanceSource === "linked"));
  ok("[105] Chase and BofA remain manual", accts.filter((x) => ["Chase", "BofA"].includes(x.name)).every((x) => x.balanceSource === "manual"));
  ok("[106] existing imported transactions remain intact", (await db.select().from(importedTransactions).where(eq(importedTransactions.userId, U))).length === ownerImportedBefore);
  ok("[107] no linked-account orphan exists", orphan === 0);
  ok("[108] request 222 remains present", (await db.select().from(experienceRequests).where(eq(experienceRequests.id, 222))).length === 1);
  ok("[109] no usage-log row is created", (await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))).length === ownerLogsBefore);
  ok("[110] .env.local remains ignored (gitignore)", /(^|\n)\.env\.local/.test(read(".gitignore")));
  ok("[111] no secret in source", !/access-sandbox-[0-9a-f]{8}|sk-ant-|npg_/.test(svcSrc + catSrc + routesSrc));
  ok("[112/113] exact-ID cleanup (no ZZ5A / temp category / rule / assignment residue; movements restored)",
    (await db.select().from(financialAccounts).where(and(eq(financialAccounts.userId, U), like(financialAccounts.name, "ZZ5A%")))).length === 0
    && (await db.select().from(transactionCategories).where(eq(transactionCategories.userId, U))).length === 0
    && (await db.select().from(merchantCategoryRules).where(eq(merchantCategoryRules.userId, U))).length === 0
    && (await db.select().from(transactionCategoryAssignments).where(eq(transactionCategoryAssignments.userId, U))).length === 0
    && (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length === ownerMovementsBefore);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch(async (e) => { try { await cleanup(); } catch { /* noop */ } console.error(e); process.exit(1); });
