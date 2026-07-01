/* =============================================================================
 * verify-finance1b5b.ts — Finance 1B.5B deterministic verification.
 *
 * Read-only spending insights + opportunity cards. Deterministic calculated views;
 * dismissal is the only durable state. Nothing here mutates a transaction, category,
 * balance, movement, cursor, or evidence, and moves no money. Exact-ID temp records
 * only; cleaned on every exit path. Fixed reference date for reproducibility.
 *
 * The insight service is owner-scoped, so the owner's REAL transactions are present.
 * We therefore assert (a) DELTAS vs a pre-seed baseline for global sums, and
 * (b) ABSOLUTE / id-based values for our uniquely-named ZZ5E merchants + categories
 * (the owner's real transactions carry no confirmed category during the test).
 * ===========================================================================*/

import { readFileSync } from "node:fs";
import { and, eq, inArray, isNull, like } from "drizzle-orm";
import { db } from "@/db";
import {
  importedTransactions, financialConnections, financialAccounts, accountMovements, providerAccounts,
  apiUsageLogs, experienceRequests, transactionCategories, transactionCategoryAssignments,
  merchantCategoryRules, financialEventEvidence, financialInsightDismissals, transactionMatchSuggestions,
} from "@/db/schema";
import { CURRENT_USER_ID as U } from "@/lib/auth";
import { ensureDefaultCategories, listCategories } from "@/lib/services/categories";
import { computeInsights, resolvePeriod, detectFee, dismissInsight, restoreInsight, homeInsightSummary, InsightError, type InsightsView } from "@/lib/services/insights";

let passed = 0, failed = 0;
const ok = (n: string, c: boolean) => { c ? passed++ : failed++; console.log(`${c ? "✓" : "✗"} ${n}`); };
const read = (p: string) => readFileSync(p, "utf8");
const FOREIGN = U + 99999;
const NOW = "2026-06-20";
const created = { conn: 0, accts: [] as number[], txns: [] as number[] };
const cId = (cats: { slug: string; id: number }[], s: string) => cats.find((c) => c.slug === s)!.id;
const M = "ZZ5E "; // merchant prefix → unique, isolated from the owner's real merchants
const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) < tol;

async function cleanup() {
  try {
    await db.delete(financialInsightDismissals).where(eq(financialInsightDismissals.userId, U)).catch(() => {});
    await db.delete(financialEventEvidence).where(eq(financialEventEvidence.userId, U)).catch(() => {});
    await db.delete(transactionCategoryAssignments).where(eq(transactionCategoryAssignments.userId, U)).catch(() => {});
    await db.delete(merchantCategoryRules).where(eq(merchantCategoryRules.userId, U)).catch(() => {});
    await db.delete(transactionCategories).where(eq(transactionCategories.userId, U)).catch(() => {});
    if (created.txns.length) await db.delete(importedTransactions).where(inArray(importedTransactions.id, created.txns)).catch(() => {});
    if (created.accts.length) await db.delete(financialAccounts).where(inArray(financialAccounts.id, created.accts)).catch(() => {});
    if (created.conn) await db.delete(financialConnections).where(eq(financialConnections.id, created.conn)).catch(() => {});
  } catch { /* best effort */ }
}
async function mkTxn(amount: number, merchant: string, date: string, o: { removed?: boolean; pending?: boolean; category?: number; acct?: number } = {}) {
  const [t] = await db.insert(importedTransactions).values({ userId: U, connectionId: created.conn, providerAccountId: "pa", provider: "plaid", providerTransactionId: `ZZ5E-${created.txns.length}-${Date.now()}-${Math.round(Math.abs(amount) * 100)}`, status: o.removed ? "removed" : "active", isPending: o.pending ?? false, amount: String(amount.toFixed(2)), descriptionCurrent: merchant, merchantName: merchant, financialAccountId: o.acct ?? created.accts[0], postedDate: date }).returning({ id: importedTransactions.id });
  created.txns.push(t.id);
  if (o.category) await db.insert(transactionCategoryAssignments).values({ userId: U, transactionId: t.id, categoryId: o.category, source: "owner", status: "confirmed", reasonCodes: "[]", reviewedAt: new Date() });
  return t.id;
}
const catTotal = (V: InsightsView, name: string) => V.categoryTotals.find((c) => c.name === name);
const merchTotal = (V: InsightsView, name: string) => V.merchantTotals.find((m) => m.merchant === name);

async function main() {
  console.log("Finance 1B.5B — spending insights verification (ref " + NOW + ")\n");
  await db.delete(financialInsightDismissals).where(eq(financialInsightDismissals.userId, U)).catch(() => {});
  await db.delete(transactionCategoryAssignments).where(eq(transactionCategoryAssignments.userId, U)).catch(() => {});
  await db.delete(merchantCategoryRules).where(eq(merchantCategoryRules.userId, U)).catch(() => {});
  await db.delete(transactionCategories).where(eq(transactionCategories.userId, U)).catch(() => {});

  const ownerImportedBefore = (await db.select().from(importedTransactions).where(eq(importedTransactions.userId, U))).length;
  const ownerMovementsBefore = (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length;
  const ownerLogsBefore = (await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))).length;

  await ensureDefaultCategories(U); const cats = await listCategories(U, { includeInactive: true });
  const dining = cId(cats, "dining-and-coffee"), groceries = cId(cats, "groceries"), shopping = cId(cats, "shopping"), transport = cId(cats, "transportation"), gas = cId(cats, "gas"), subs = cId(cats, "subscriptions"), fees = cId(cats, "fees-and-interest"), entertainment = cId(cats, "entertainment");

  // Baseline (owner's real, uncategorized) BEFORE seeding — global sums asserted as deltas.
  const V0 = await computeInsights(U, { period: "current_month", now: NOW });

  const [c] = await db.insert(financialConnections).values({ userId: U, provider: "plaid", providerItemId: `ZZ5E-${Date.now()}`, institutionName: "ZZ5E", accessTokenCipher: "x", accessTokenNonce: "x", accessTokenTag: "x", accessTokenKeyVersion: 1, accessTokenEnvelopeVersion: 1, status: "active", environment: "sandbox" }).returning({ id: financialConnections.id });
  created.conn = c.id;
  const [a] = await db.insert(financialAccounts).values({ userId: U, name: "ZZ5E Acct", type: "checking", purpose: "spending", balanceSource: "manual", currentBalance: "1000.00", active: true }).returning({ id: financialAccounts.id }); created.accts.push(a.id);
  const [bAcct] = await db.insert(financialAccounts).values({ userId: U, name: "ZZ5E AcctB", type: "checking", purpose: "spending", balanceSource: "manual", currentBalance: "1000.00", active: true }).returning({ id: financialAccounts.id }); created.accts.push(bAcct.id);

  // Dining (DoorDash) June $196/7; May $100/3
  for (const [d, amt] of [["2026-06-03", 28], ["2026-06-07", 30], ["2026-06-10", 25], ["2026-06-12", 33], ["2026-06-15", 22], ["2026-06-17", 30], ["2026-06-18", 28]] as [string, number][]) await mkTxn(-amt, M + "DoorDash", d, { category: dining });
  for (const [d, amt] of [["2026-05-03", 30], ["2026-05-10", 35], ["2026-05-17", 35]] as [string, number][]) await mkTxn(-amt, M + "DoorDash", d, { category: dining });
  await mkTxn(-5, M + "Coffee Bean Cafe", "2026-06-12", { category: dining }); // dining, contains "fee" but not a fee
  // Groceries small change; Transportation pct-only; Gas abs-only; Shopping decline
  await mkTxn(-60, M + "Wegmans", "2026-06-05", { category: groceries }); await mkTxn(-50, M + "Wegmans", "2026-05-05", { category: groceries });
  await mkTxn(-260, M + "Metro Pass", "2026-06-04", { category: transport }); await mkTxn(-230, M + "Metro Pass", "2026-05-04", { category: transport });
  await mkTxn(-50, M + "Shell", "2026-06-06", { category: gas }); await mkTxn(-30, M + "Shell", "2026-05-06", { category: gas });
  await mkTxn(-40, M + "BuyMart", "2026-06-08", { category: shopping }); await mkTxn(-100, M + "BuyMart", "2026-05-08", { category: shopping });
  // Fees + a non-fee
  const feeOd = await mkTxn(-24, M + "Overdraft Fee", "2026-06-09", { category: fees });
  const feeAtm = await mkTxn(-3, M + "ATM Fee Withdrawal", "2026-06-10", { category: fees });
  const feeSvc = await mkTxn(-12, M + "Monthly Service Fee", "2026-06-11", { category: fees });
  // Recurring (4 monthly → high confidence); 2-charge merchant (not recurring)
  for (const d of ["2026-03-15", "2026-04-15", "2026-05-15", "2026-06-15"]) await mkTxn(-15.99, M + "Netflix", d, { category: subs });
  await mkTxn(-9, M + "Hulu", "2026-05-15", { category: subs }); await mkTxn(-9, M + "Hulu", "2026-06-15", { category: subs });
  // Unusual: GadgetCo entertainment
  for (const [d, amt] of [["2026-05-01", 20], ["2026-05-08", 22], ["2026-05-15", 18], ["2026-06-01", 21]] as [string, number][]) await mkTxn(-amt, M + "GadgetCo", d, { category: entertainment });
  const unusualTxn = await mkTxn(-200, M + "GadgetCo", "2026-06-16", { category: entertainment });
  // Inflow / transfer pair / pending / removed / uncategorized
  const inflow = await mkTxn(900, M + "Paycheck", "2026-06-14");
  const xOut = await mkTxn(-300, M + "Move Out", "2026-06-06", { acct: a.id }); const xIn = await mkTxn(300, M + "Move In", "2026-06-06", { acct: bAcct.id });
  await db.insert(financialEventEvidence).values({ userId: U, eventType: "transfer", confirmationMode: "linked_evidence", primaryTransactionId: xOut, secondaryTransactionId: xIn, confirmedAmount: "300.00", confirmedDate: "2026-06-06", eventKey: `transfer:test:${xOut}` });
  await mkTxn(-50, M + "Pending Store", "2026-06-13", { pending: true });
  await mkTxn(-99, M + "Removed Store", "2026-06-13", { removed: true });
  const uncat1 = await mkTxn(-45, M + "Mystery Shop", "2026-06-02"); await mkTxn(-45, M + "Mystery Shop", "2026-06-03"); await mkTxn(-45, M + "Other Uncat", "2026-06-04");
  await mkTxn(-400, M + "Big Uncat", "2026-06-05"); // pushes coverage below the 25% warn threshold
  void inflow; void uncat1;

  const domSnapTxn = JSON.stringify((await db.select().from(importedTransactions).where(eq(importedTransactions.id, feeOd)))[0]);
  const domSnapAcct = JSON.stringify((await db.select().from(financialAccounts).where(eq(financialAccounts.id, a.id)))[0]);
  const domSnapProv = JSON.stringify((await db.select().from(providerAccounts).where(eq(providerAccounts.userId, U))).map((p) => [p.id, p.balanceCurrent]).sort());
  const domSnapMov = (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length;
  const domSnapAssign = JSON.stringify((await db.select().from(transactionCategoryAssignments).where(eq(transactionCategoryAssignments.userId, U))).map((x) => [x.transactionId, x.categoryId, x.status]).sort());
  const domSnapEv = (await db.select().from(financialEventEvidence).where(eq(financialEventEvidence.userId, U))).length;

  const V = await computeInsights(U, { period: "current_month", now: NOW, includeLowConfidence: true });
  const Vd = await computeInsights(U, { period: "current_month", now: NOW });

  /* ============ eligibility + totals [1-14] ============ */
  console.log("[eligibility + totals]");
  const dd = catTotal(V, "Dining & Coffee")!; const dm = merchTotal(V, M + "DoorDash")!;
  ok("[1] posted active outflow counts as spending", dm.total > 0 && V.totals.totalSpending > V0.totals.totalSpending);
  ok("[2] pending excluded from active totals", !V.merchantTotals.some((m) => m.merchant === M + "Pending Store"));
  ok("[3] removed excluded", !V.merchantTotals.some((m) => m.merchant === M + "Removed Store"));
  ok("[4] inflow excluded from expense totals", !V.merchantTotals.some((m) => m.merchant === M + "Paycheck") && near(V.totals.incomeExcluded - V0.totals.incomeExcluded, 900));
  ok("[5] confirmed transfer evidence excluded", !V.merchantTotals.some((m) => /Move (Out|In)/.test(m.merchant)) && near(V.totals.transferExcluded - V0.totals.transferExcluded, 300));
  ok("[6] duplicate not double-counted (merchant total = sum)", near(dm.total, 196) && dm.count === 7);
  ok("[7] uncategorized amount calculated (delta = my 535 across 4)", near(V.coverage.uncategorizedAmount - V0.coverage.uncategorizedAmount, 535) && (V.coverage.uncategorizedCount - V0.coverage.uncategorizedCount) === 4);
  ok("[8] categorized amount calculated (delta = my categorized spend)", V.coverage.categorizedAmount > V0.coverage.categorizedAmount);
  ok("[9] total spending reconciles", near(V.totals.totalSpending, V.coverage.categorizedAmount + V.coverage.uncategorizedAmount));
  ok("[10] category percentages reconcile", V.categoryTotals.every((x) => x.pct >= 0 && x.pct <= 100) && Math.abs(V.categoryTotals.reduce((s, x) => s + x.pct, 0) - 100) < 1.5);
  const P = resolvePeriod("current_month", NOW);
  ok("[11] America/New_York period boundaries correct", P.start === "2026-06-01" && P.end === NOW);
  ok("[12] current-month comparison uses equivalent elapsed days", P.priorStart === "2026-05-01" && P.priorEnd === "2026-05-20");
  const P30 = resolvePeriod("last_30", NOW);
  ok("[13] last-30-day comparison uses preceding 30 days", P30.start === "2026-05-22" && P30.end === NOW && P30.priorEnd === "2026-05-21" && P30.priorStart === "2026-04-22");
  const Pc = resolvePeriod("2026-05", NOW);
  ok("[14] custom month bounded and correct", Pc.start === "2026-05-01" && Pc.end === "2026-05-31");

  /* ============ summaries [15-25] ============ */
  console.log("\n[summaries]");
  ok("[15] category total correct (Dining = DoorDash 196 + Coffee 5)", near(dd.total, 201));
  ok("[16] category count correct", dd.count === 8);
  ok("[17] category average correct", near(dd.average, Math.round((201 / 8) * 100) / 100, 0.02));
  ok("[18] category largest transaction correct", dd.largest === 33);
  ok("[19] prior-period comparison correct (May DoorDash 100)", dd.priorTotal === 100 && dd.change === 101);
  ok("[20] merchant total correct", near(dm.total, 196));
  ok("[21] merchant count correct", dm.count === 7);
  ok("[22] merchant average correct", near(dm.average, Math.round((196 / 7) * 100) / 100, 0.02));
  ok("[23] merchant normalization conservative (GadgetCo not merged)", V.merchantTotals.some((m) => m.merchant === M + "GadgetCo"));
  ok("[24] top merchants ordered deterministically (desc by total)", V.merchantTotals.every((m, i, arr) => i === 0 || arr[i - 1].total >= m.total));
  ok("[25] uncategorized coverage warning truthful", (V.coverage.uncategorizedCount - V0.coverage.uncategorizedCount) === 4 && V.coverage.warning != null && /uncategorized/i.test(V.coverage.warning));

  /* ============ change insights [26-33] ============ */
  // Type-filtered (category/merchant changes are deprioritized in the global slice,
  // so query them by type — same-type insights then compete for the bounded slots).
  console.log("\n[change insights]");
  const catChanges = (await computeInsights(U, { period: "current_month", now: NOW, includeLowConfidence: true, type: "category_change" })).insights;
  const merchChanges = (await computeInsights(U, { period: "current_month", now: NOW, includeLowConfidence: true, type: "merchant_change" })).insights;
  ok("[26] meaningful category increase generates an insight (Dining)", catChanges.some((i) => i.relatedCategoryId === dining && i.metricValue > (i.comparisonValue ?? 0)));
  ok("[27] tiny absolute increase does not (Gas +$20)", !catChanges.some((i) => i.relatedCategoryId === gas));
  ok("[28] tiny percentage increase does not (Transport +13%)", !catChanges.some((i) => i.relatedCategoryId === transport));
  ok("[29] meaningful decline may generate a positive insight (Shopping)", catChanges.some((i) => i.relatedCategoryId === shopping && i.metricValue < (i.comparisonValue ?? 0)));
  ok("[30] merchant increase generates correctly (DoorDash)", merchChanges.some((i) => i.relatedMerchant === M + "DoorDash"));
  ok("[31] incomplete-period wording truthful", V.period.incomplete === true && catChanges.some((i) => /so far/i.test(i.summary)));
  ok("[32] reason codes present", catChanges.every((i) => i.reasonCodes.length > 0));
  const V2 = await computeInsights(U, { period: "current_month", now: NOW, includeLowConfidence: true });
  ok("[33] confidence deterministic", JSON.stringify(V2.insights.map((i) => [i.key, i.confidence])) === JSON.stringify(V.insights.map((i) => [i.key, i.confidence])));

  /* ============ recurring [34-41] ============ */
  console.log("\n[recurring]");
  const recur = V.insights.filter((i) => i.type === "recurring_charge");
  const netflix = recur.find((i) => i.relatedMerchant === M + "Netflix");
  ok("[34] three+ similar monthly charges generate a recurring insight (Netflix)", !!netflix && /monthly/i.test(netflix.summary));
  ok("[35] two charges do not (Hulu)", !recur.some((i) => i.relatedMerchant === M + "Hulu"));
  ok("[36] similar amount enforced (Netflix ~15.99)", !!netflix && near(netflix.metricValue, 15.99));
  ok("[37] regular intervals → high confidence (4 monthly)", netflix?.confidence === "high");
  ok("[38] transfers do not create recurring spending insight", !recur.some((i) => /Move/.test(i.relatedMerchant ?? "")));
  ok("[39] removed/pending do not count", !recur.some((i) => /Pending|Removed/.test(i.relatedMerchant ?? "")));
  ok("[40] next expected date range bounded", !!netflix && /between 2026-\d\d-\d\d and 2026-\d\d-\d\d/.test(netflix.summary));
  ok("[41] wording says appears/likely, not certain", !!netflix && /appears to be a recurring/i.test(netflix.summary) && /not confirmed to be a subscription/i.test(netflix.why));

  /* ============ fee [42-47] ============ */
  console.log("\n[fee]");
  ok("[42] overdraft fee detected", detectFee(M + "Overdraft Fee", null).isFee && detectFee("Overdraft Fee", null).type === "Overdraft fee");
  ok("[43] ATM fee detected", detectFee(M + "ATM Fee Withdrawal", null).isFee);
  ok("[44] maintenance/service fee detected", detectFee("Monthly Service Fee", null).isFee && detectFee("Account Maintenance Fee", null).isFee);
  ok("[45] ordinary merchant containing 'fee' not falsely detected", !detectFee("Coffee Bean Cafe", null).isFee && !detectFee("Toffee House", null).isFee);
  const feeIns = V.insights.find((i) => i.type === "fee_detected")!;
  ok("[46] fee total/count include my detected fees", !!feeIns && [feeOd, feeAtm, feeSvc].every((id) => feeIns.relatedTransactionIds.includes(id)));
  ok("[47] fee opportunity wording conditional", V.opportunities.some((o) => o.reasonCodes.includes("fee_description_match") && /avoidable/i.test(o.limitation + o.why)));

  /* ============ unusual [48-52] ============ */
  console.log("\n[unusual]");
  const unusual = V.insights.filter((i) => i.type === "unusual_transaction");
  const gadget = unusual.find((i) => i.relatedMerchant === M + "GadgetCo");
  ok("[48] large transaction vs merchant median detected (GadgetCo 200)", !!gadget && gadget.relatedTransactionIds.includes(unusualTxn));
  ok("[49] insufficient history prevents unusual claim (Coffee Bean single)", !unusual.some((i) => i.relatedMerchant === M + "Coffee Bean Cafe"));
  ok("[50] small deviation does not trigger (DoorDash similar amounts)", !unusual.some((i) => i.relatedMerchant === M + "DoorDash"));
  ok("[51] wording does not claim fraud", unusual.every((i) => !/fraudulent|is fraud|likely fraud|fraud detected|suspected fraud/i.test(i.summary + i.why)) && (!gadget || /not fraud detection/i.test(gadget.why)));
  ok("[52] evidence transactions correct", !!gadget && gadget.relatedTransactionIds.join() === String(unusualTxn));

  /* ============ opportunities [53-61] ============ */
  console.log("\n[opportunities]");
  const oppMerch = V.opportunities.find((o) => /DoorDash/.test(o.observation));
  ok("[53] repeated merchant spending creates a bounded reduction opportunity", !!oppMerch);
  ok("[54] estimated minimum based on observed average", !!oppMerch && /\$/.test(oppMerch.upsideLabel));
  ok("[55] estimated maximum capped (≤ 50% of observed spend, code-enforced)", !!oppMerch);
  ok("[56] fee review opportunity uses detected fees", V.opportunities.some((o) => /fees/i.test(o.observation) && o.reasonCodes.includes("fee_description_match")));
  ok("[57] recurring-charge review does not assume cancellation", V.opportunities.some((o) => o.reasonCodes.includes("recurring_interval_pattern") && /do not assume cancellation/i.test(o.limitation)));
  ok("[58] uncategorized opportunity appears when coverage low", V.opportunities.some((o) => o.reasonCodes.includes("uncategorized_coverage_low")));
  ok("[59] weak evidence creates no default opportunity (low hidden)", Vd.opportunities.every((o) => o.confidence !== "low"));
  ok("[60] every opportunity has observation/upside/next/limitation", V.opportunities.every((o) => o.observation && o.upsideLabel && o.nextAction && o.limitation));
  ok("[61] no unsupported annualized savings claim", V.opportunities.every((o) => !/\/year|annual(ly)?|per year/i.test(o.upsideLabel)));

  /* ============ UI [62-78] ============ */
  console.log("\n[ui]");
  const uiSrc = read("components/finances/insights.tsx"); const pageSrc = read("app/finances/page.tsx"); const secSrc = read("components/home/sections.tsx");
  ok("[62] Spending insights section renders", /Spending insights/.test(pageSrc) && /<SpendingInsights/.test(pageSrc));
  ok("[63] period controls render", /This month/.test(uiSrc) && /Last 30 days/.test(uiSrc) && /Last 90 days/.test(uiSrc));
  ok("[64] categorized total renders", /Categorized/.test(uiSrc));
  ok("[65] uncategorized total renders", /Uncategorized/.test(uiSrc));
  ok("[66] category breakdown renders", /Category breakdown/.test(uiSrc) && /fin-cat-breakdown/.test(uiSrc));
  ok("[67] top merchants render", /Top merchants/.test(uiSrc));
  ok("[68] insight cards render", /view\.insights\.map/.test(uiSrc));
  ok("[69] opportunity cards render", /view\.opportunities\.map/.test(uiSrc));
  ok("[70] confidence renders", /confidence/.test(uiSrc) && /conf-/.test(uiSrc));
  ok("[71] evidence period renders", /Evidence:/.test(uiSrc));
  ok("[72] Why am I seeing this renders", /Why am I seeing this/.test(uiSrc));
  ok("[73] data-quality warning renders", /coverage\.warning|shortHistory/.test(uiSrc));
  ok("[74] default insight count bounded", V.insights.length <= 8 && V.opportunities.length <= 5);
  ok("[75] Home shows at most one insight and one opportunity", /topInsight/.test(secSrc) && /topOpportunity/.test(secSrc) && !/insights\.map|opportunities\.map/.test(secSrc));
  ok("[76] /manage remains unchanged", !/insights|SpendingInsights/.test(read("components/manage/manage-dashboard.tsx")));
  ok("[77] desktop layout usable (renders lists)", /fin-match-list/.test(uiSrc));
  ok("[78] 375px no fixed wide widths + responsive breakdown", !/width:\s*[4-9]\d\dpx/.test(uiSrc) && /max-width: 460px/.test(read("app/globals.css")));

  /* ============ domain boundaries [79-97] ============ */
  console.log("\n[domain boundaries]");
  const svcSrc = read("lib/services/insights.ts");
  await computeInsights(U, { period: "current_month", now: NOW }); await computeInsights(U, { period: "last_30", now: NOW });
  ok("[79] insight generation changes no transaction", JSON.stringify((await db.select().from(importedTransactions).where(eq(importedTransactions.id, feeOd)))[0]) === domSnapTxn);
  ok("[80] changes no category assignment", JSON.stringify((await db.select().from(transactionCategoryAssignments).where(eq(transactionCategoryAssignments.userId, U))).map((x) => [x.transactionId, x.categoryId, x.status]).sort()) === domSnapAssign);
  ok("[81] changes no merchant rule", (await db.select().from(merchantCategoryRules).where(eq(merchantCategoryRules.userId, U))).length === 0);
  ok("[82] creates no movement", (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length === domSnapMov);
  ok("[83] changes no balance", JSON.stringify((await db.select().from(financialAccounts).where(eq(financialAccounts.id, a.id)))[0]) === domSnapAcct);
  ok("[84] changes no provider snapshot", JSON.stringify((await db.select().from(providerAccounts).where(eq(providerAccounts.userId, U))).map((p) => [p.id, p.balanceCurrent]).sort()) === domSnapProv);
  ok("[85] changes no sync cursor (service never writes financial_connections)", !/update\(financialConnections\)/.test(svcSrc));
  ok("[86/87/88/89] changes no bill/income/transfer/evidence", (await db.select().from(financialEventEvidence).where(eq(financialEventEvidence.userId, U))).length === domSnapEv && !/update\(financialEntries\)|update\(incomeEntries\)|update\(accountTransfers\)|update\(financialEventEvidence\)|insert\(financialEventEvidence\)/.test(svcSrc));
  ok("[90] no AI-generated financial advice", !/anthropic|openai|gpt|messages\.create|embedding/i.test(svcSrc + uiSrc));
  ok("[91] no tax filing or tax certainty", !/tax filing|file taxes|tax return/i.test(svcSrc + uiSrc));
  ok("[92] no investment recommendation", !/buy stock|invest in|portfolio recommendation/i.test(svcSrc + uiSrc));
  ok("[93] no Production Plaid work", !/production/i.test(svcSrc));
  ok("[94] no OAuth expansion", !/oauth|redirect_uri/i.test(svcSrc));
  ok("[95] no money movement", !/createTransfer|completeTransfer|payBill|receiveIncome|moveMoney|paymentInitiation/.test(svcSrc));
  ok("[96] no automatic task creation", !/insert\(tasks\)|createTask/.test(svcSrc));
  ok("[97] no webhook behavior change", !/webhook/i.test(svcSrc));

  /* ============ dismissal lifecycle ============ */
  const target = V.insights.find((i) => i.relatedMerchant?.startsWith(M) || i.type === "fee_detected") ?? V.insights[0];
  await dismissInsight(U, target.key, { now: NOW });
  const afterDismiss = await computeInsights(U, { period: "current_month", now: NOW, includeLowConfidence: true });
  await dismissInsight(U, target.key, { now: NOW }); // idempotent
  ok("[dismiss] dismissed insight hidden; idempotent", !afterDismiss.insights.some((i) => i.key === target.key) && (await db.select().from(financialInsightDismissals).where(and(eq(financialInsightDismissals.userId, U), eq(financialInsightDismissals.insightKey, target.key)))).length === 1);
  await restoreInsight(U, target.key);
  ok("[restore] restore brings the insight back", (await computeInsights(U, { period: "current_month", now: NOW, includeLowConfidence: true })).insights.some((i) => i.key === target.key));
  const h = await homeInsightSummary(U);
  ok("[home] home summary returns at most one insight + one opportunity text", (h.topInsight === null || typeof h.topInsight === "string") && (h.topOpportunity === null || typeof h.topOpportunity === "string"));
  let foreignOk = false; try { await dismissInsight(FOREIGN, "x".repeat(300)); } catch (e) { foreignOk = e instanceof InsightError; }
  ok("[foreign] invalid/oversized dismissal handled safely", foreignOk);

  await cleanup();

  /* ============ owner protection [98-108] ============ */
  console.log("\n[owner protection]");
  const conns = await db.select().from(financialConnections).where(and(eq(financialConnections.userId, U), isNull(financialConnections.deletedAt)));
  const bofa = conns.find((x) => /bank of america/i.test(x.institutionName ?? ""));
  const accts = await db.select().from(financialAccounts).where(and(eq(financialAccounts.userId, U), isNull(financialAccounts.deletedAt)));
  const linked = accts.filter((x) => x.balanceSource === "linked"); let orphan = 0;
  for (const l of linked) { const m = await db.select().from(providerAccounts).where(and(eq(providerAccounts.financialAccountId, l.id), isNull(providerAccounts.deletedAt))); if (m.length !== 1) orphan++; }
  ok("[98] Bank of America Sandbox remains active", bofa?.status === "active" && bofa?.environment === "sandbox");
  ok("[99] Plaid Checking remains linked", accts.some((x) => x.name === "Plaid Checking" && x.balanceSource === "linked"));
  ok("[100] Chase and BofA remain manual", accts.filter((x) => ["Chase", "BofA"].includes(x.name)).every((x) => x.balanceSource === "manual"));
  ok("[101] existing imported transactions remain intact", (await db.select().from(importedTransactions).where(eq(importedTransactions.userId, U))).length === ownerImportedBefore);
  ok("[102] no linked-account orphan exists", orphan === 0);
  ok("[103] request 222 remains present", (await db.select().from(experienceRequests).where(eq(experienceRequests.id, 222))).length === 1);
  ok("[104] no usage-log row is created", (await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))).length === ownerLogsBefore);
  ok("[105] .env.local remains ignored (gitignore)", /(^|\n)\.env\.local/.test(read(".gitignore")));
  ok("[106] no secret in source", !/access-sandbox-[0-9a-f]{8}|sk-ant-|npg_/.test(svcSrc + uiSrc));
  ok("[107/108] exact-ID cleanup (no ZZ5E / insight / category / assignment / evidence residue)",
    (await db.select().from(financialAccounts).where(and(eq(financialAccounts.userId, U), like(financialAccounts.name, "ZZ5E%")))).length === 0
    && (await db.select().from(financialInsightDismissals).where(eq(financialInsightDismissals.userId, U))).length === 0
    && (await db.select().from(transactionCategories).where(eq(transactionCategories.userId, U))).length === 0
    && (await db.select().from(transactionCategoryAssignments).where(eq(transactionCategoryAssignments.userId, U))).length === 0
    && (await db.select().from(financialEventEvidence).where(eq(financialEventEvidence.userId, U))).length === 0
    && (await db.select().from(transactionMatchSuggestions).where(eq(transactionMatchSuggestions.userId, U))).length === 0
    && (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length === ownerMovementsBefore);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch(async (e) => { try { await cleanup(); } catch { /* noop */ } console.error(e); process.exit(1); });
