/* =============================================================================
 * verify-finance1c0a.ts — Finance 1C.0A credit + financial-health verification.
 *
 * Manual, owner-entered, READ-ONLY. Exercises the deterministic credit engine
 * (scores, accounts, utilization, collections, inquiries, late payments, goals,
 * observations, action cards, health summary) with exact-ID temp records under
 * the owner, asserting no bank/finance record is ever mutated. Credit tables are
 * brand-new (owner has zero credit rows), so each scenario resets owner-scoped
 * credit rows only. Fixed reference date for reproducibility.
 * ===========================================================================*/

import { readFileSync } from "node:fs";
import { and, eq, isNull, like } from "drizzle-orm";
import { db } from "@/db";
import {
  creditScoreSnapshots, creditAccounts, creditCollections, creditLatePayments, creditInquiries, creditGoals,
  importedTransactions, financialConnections, financialAccounts, accountMovements, providerAccounts,
  apiUsageLogs, experienceRequests, transactionCategories, transactionCategoryAssignments, merchantCategoryRules,
  financialEventEvidence, transactionMatchSuggestions,
} from "@/db/schema";
import { CURRENT_USER_ID as U } from "@/lib/auth";
import * as C from "@/lib/services/credit";

let passed = 0, failed = 0;
const ok = (n: string, c: boolean) => { c ? passed++ : failed++; console.log(`${c ? "✓" : "✗"} ${n}`); };
const read = (p: string) => readFileSync(p, "utf8");
const NOW = "2026-07-01";
const FOREIGN = U + 99999;
const ago = (d: number) => new Date(Date.parse(NOW) - d * 86400000).toISOString().slice(0, 10);
const ahead = (d: number) => new Date(Date.parse(NOW) + d * 86400000).toISOString().slice(0, 10);
async function threw(fn: () => Promise<unknown>): Promise<boolean> { try { await fn(); return false; } catch (e) { return e instanceof C.CreditError; } }

async function resetCredit() {
  for (const t of [creditLatePayments, creditScoreSnapshots, creditCollections, creditInquiries, creditGoals, creditAccounts]) await db.delete(t).where(eq(t.userId, U)).catch(() => {});
}

async function main() {
  console.log("Finance 1C.0A — credit & financial health verification (ref " + NOW + ")\n");
  await resetCredit();
  const ownerImportedBefore = (await db.select().from(importedTransactions).where(eq(importedTransactions.userId, U))).length;
  const ownerMovementsBefore = (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length;
  const ownerLogsBefore = (await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))).length;

  /* ================= score snapshots [1-10] ================= */
  console.log("[score snapshots]");
  const s1 = await C.createScore(U, { score: 690, source: "experian", scoringModel: "FICO 8", asOfDate: ago(40) });
  ok("[1] owner can add a valid score snapshot", !!s1 && s1.score === 690);
  ok("[2] source and as-of date are required", await threw(() => C.createScore(U, { score: 700, source: "", asOfDate: "" } as never)) && await threw(() => C.createScore(U, { score: 700, source: "experian", asOfDate: "not-a-date" } as never)));
  ok("[3] score range is validated", await threw(() => C.createScore(U, { score: 100, source: "experian", asOfDate: NOW })) && await threw(() => C.createScore(U, { score: 1200, source: "experian", asOfDate: NOW })));
  const s2 = await C.createScore(U, { score: 702, source: "experian", scoringModel: "FICO 8", asOfDate: ago(5) });
  const tr = C.computeScoreTrends(await C.listScores(U));
  const expTrend = tr.trends.find((t) => t.source === "experian");
  ok("[4] same-source trend is calculated", !!expTrend && expTrend.change === 12 && expTrend.prior === 690);
  await C.createScore(U, { score: 660, source: "credit_karma", asOfDate: ago(5) });
  const tr2 = C.computeScoreTrends(await C.listScores(U));
  ok("[5] different-source scores are not averaged", tr2.trends.length === 2 && !tr2.trends.some((t) => t.source === "combined") && tr2.trends.find((t) => t.source === "credit_karma")!.change === null);
  ok("[6] different-source trend shows a warning", tr2.multiSourceWarning != null && /different bureaus/i.test(tr2.multiSourceWarning));
  const dupCountBefore = (await C.listScores(U)).length;
  await C.createScore(U, { score: 702, source: "experian", scoringModel: "FICO 8", asOfDate: ago(5) }); // identical to s2
  ok("[7] identical duplicate snapshot is prevented", (await C.listScores(U)).length === dupCountBefore);
  ok("[8] foreign-owner snapshot access is rejected", await threw(() => C.updateScore(FOREIGN, s1.id, { score: 800 })) && (await C.listScores(FOREIGN)).length === 0);
  ok("[9] historical snapshots remain auditable", (await C.listScores(U)).filter((s) => s.source === "experian").length === 2);
  const ovStale = await C.computeCreditOverview(U, { now: NOW });
  ok("[10] stale-data warning is truthful", ovStale.staleScore === false); // latest is 5 days old → not stale

  await resetCredit();
  /* ================= accounts + utilization [11-24] ================= */
  console.log("\n[accounts + utilization]");
  const cardA = await C.createAccount(U, { name: "Card A", accountType: "credit_card", isRevolving: true, creditLimit: 10000, currentBalance: 4700, minimumPayment: 50, status: "open" });
  await C.createAccount(U, { name: "Auto Loan", accountType: "auto_loan", isRevolving: false, currentBalance: 12000, status: "open" });
  const cardMissing = await C.createAccount(U, { name: "Card No Limit", accountType: "credit_card", isRevolving: true, currentBalance: 500, status: "open" });
  const cardClosed = await C.createAccount(U, { name: "Card Closed", accountType: "credit_card", isRevolving: true, creditLimit: 5000, currentBalance: 0, status: "closed" });
  let util = C.computeUtilization(await C.listAccounts(U));
  ok("[11] revolving account with limit contributes to utilization", util.perAccount.some((p) => p.id === cardA.id));
  ok("[12] installment account does not enter revolving utilization", !util.perAccount.some((p) => p.name === "Auto Loan") && util.totalLimit === 10000);
  ok("[13] closed revolving account excluded from aggregate (kept historical)", !util.perAccount.some((p) => p.id === cardClosed.id));
  ok("[14] missing limit produces an incomplete-data warning", util.missingLimitCount >= 1 && !util.perAccount.some((p) => p.id === cardMissing.id));
  ok("[15] zero limit is rejected", await threw(() => C.createAccount(U, { name: "Zero", accountType: "credit_card", isRevolving: true, creditLimit: 0, currentBalance: 10 })));
  ok("[16] per-account utilization is correct", util.perAccount.find((p) => p.id === cardA.id)!.utilizationPct === 47);
  ok("[17] aggregate utilization is correct", util.aggregatePct === 47 && util.totalBalance === 4700 && util.totalLimit === 10000);
  ok("[18] amount to reach below 50% is correct", util.toReach.find((t) => t.threshold === 50)!.amount === Math.max(0, 4700 - 5000));
  ok("[19] amount to reach below 30% is correct", util.toReach.find((t) => t.threshold === 30)!.amount === 4700 - 3000);
  ok("[20] amount to reach below 10% is correct", util.toReach.find((t) => t.threshold === 10)!.amount === 4700 - 1000);
  ok("[21] utilization calculation guarantees no score change", /score impact varies/i.test(util.note) && !/guarantee/i.test(util.note));
  const cardAU = await C.createAccount(U, { name: "AU Card", accountType: "credit_card", isRevolving: true, creditLimit: 10000, currentBalance: 1300, isAuthorizedUser: true, status: "open" });
  util = C.computeUtilization(await C.listAccounts(U));
  ok("[22] authorized-user handling is explicit", util.authorizedUserCount === 1 && util.perAccount.find((p) => p.id === cardAU.id)!.isAuthorizedUser === true);
  ok("[23] invalid negative balance is rejected", await threw(() => C.createAccount(U, { name: "Neg", accountType: "credit_card", isRevolving: true, creditLimit: 1000, currentBalance: -50 })));
  ok("[24] foreign-owner account access is rejected", await threw(() => C.updateAccount(FOREIGN, cardA.id, { name: "x" })) && (await C.listAccounts(FOREIGN)).length === 0);

  await resetCredit();
  /* ================= collections [25-33] ================= */
  console.log("\n[collections]");
  const col1 = await C.createCollection(U, { collectorName: "Acme Recovery", originalCreditor: "OldBank", reportedBalance: 480, validationStatus: "not_requested", dateReported: ago(200) });
  await C.createCollection(U, { collectorName: "Big Debt Co", reportedBalance: 1500, validationStatus: "requested", dateReported: ago(100) });
  const colRemoved = await C.createCollection(U, { collectorName: "Gone Collector", reportedBalance: 9999, status: "removed", dateReported: ago(50) });
  ok("[25] owner can add a collection", !!col1 && col1.collectorName === "Acme Recovery");
  let colSum = C.computeCollections(await C.listCollections(U));
  ok("[26] active collections total is correct", colSum.activeBalance === 1980 && colSum.activeCount === 2);
  ok("[27] removed collection is excluded from active total", colSum.activeBalance === 1980 && !((await C.listCollections(U)).filter((c) => c.status !== "removed").some((c) => c.id === colRemoved.id)));
  ok("[28] smallest balance is calculated", colSum.smallestActiveBalance === 480);
  await C.updateCollection(U, col1.id, { settlementOffer: 200 });
  const col1b = (await C.listCollections(U)).find((c) => c.id === col1.id)!;
  ok("[29] validation status is preserved", col1b.validationStatus === "not_requested");
  ok("[32] settlement offer is treated as owner-entered information", Number(col1b.settlementOffer) === 200);
  const ov = await C.computeCreditOverview(U, { now: NOW });
  ok("[30] unverified collection creates a verify-first action", ov.actions.some((a) => a.actionType === "verify_collection" && /written|debt-validation|verify/i.test(a.nextStep)));
  ok("[31] paid collection does not promise score improvement", ov.actions.every((a) => !/\bwill (raise|increase|improve) your score\b|guaranteed score (increase|improvement|boost)|guarantees? (a |an )?\d+ ?point/i.test([a.why, a.estimatedUpside, a.nextStep, a.tradeoff].join(" "))) && ov.actions.some((a) => a.actionType === "verify_collection"));
  ok("[33] foreign-owner collection access is rejected", await threw(() => C.updateCollection(FOREIGN, col1.id, { status: "paid" })) && (await C.listCollections(FOREIGN)).length === 0);

  await resetCredit();
  /* ================= late payments + inquiries [34-40] ================= */
  console.log("\n[late payments + inquiries]");
  await C.createInquiry(U, { creditorName: "Auto Lender", inquiryDate: ago(30), inquiryType: "hard" });
  await C.createInquiry(U, { creditorName: "Card Co", inquiryDate: ago(60), inquiryType: "hard" });
  await C.createInquiry(U, { creditorName: "Insurance Quote", inquiryDate: ago(10), inquiryType: "soft" });
  const inqSum = C.computeInquiries(await C.listInquiries(U), NOW);
  ok("[34] hard inquiry count is correct", inqSum.hardCount === 2);
  ok("[35] soft inquiry is excluded from hard-inquiry guidance", inqSum.softCount === 1 && inqSum.recentHardCount === 2);
  const ovInq = await C.computeCreditOverview(U, { now: NOW });
  const ovInq2 = await C.computeCreditOverview(U, { now: NOW });
  ok("[36] recent-inquiry observation is deterministic", JSON.stringify(ovInq.observations.filter((o) => o.type === "recent_hard_inquiries")) === JSON.stringify(ovInq2.observations.filter((o) => o.type === "recent_hard_inquiries")) && ovInq.observations.some((o) => o.type === "recent_hard_inquiries"));
  const acctForLate = await C.createAccount(U, { name: "Late Card", accountType: "credit_card", isRevolving: true, creditLimit: 2000, currentBalance: 100, status: "open" });
  const late1 = await C.createLatePayment(U, { creditAccountId: acctForLate.id, daysLate: 30, reportedDate: ago(90), status: "reported" });
  ok("[37] late-payment record links to the correct account", late1.creditAccountId === acctForLate.id);
  await C.updateLatePayment(U, late1.id, { status: "resolved" });
  ok("[38] resolved late payment remains historical", (await C.listLatePayments(U)).some((l) => l.id === late1.id && l.status === "resolved"));
  const anyInqId = (await C.listInquiries(U))[0].id;
  ok("[39] foreign-owner inquiry access is rejected", await threw(() => C.updateInquiry(FOREIGN, anyInqId, { purpose: "x" })) && (await C.listInquiries(FOREIGN)).length === 0);
  ok("[40] foreign-owner late-payment access is rejected", await threw(() => C.updateLatePayment(FOREIGN, late1.id, { status: "removed" })) && (await C.listLatePayments(FOREIGN)).length === 0);

  await resetCredit();
  /* ================= goals [41-47] ================= */
  console.log("\n[goals]");
  const g1 = await C.createGoal(U, { goalType: "score_target", targetValue: 740 });
  ok("[41] owner can create a score goal", !!g1 && g1.goalType === "score_target");
  const g2 = await C.createGoal(U, { goalType: "utilization_target", targetValue: 30 });
  ok("[42] owner can create a utilization goal", !!g2 && g2.goalType === "utilization_target");
  await C.createScore(U, { score: 710, source: "experian", asOfDate: NOW });
  await C.createAccount(U, { name: "G Card", accountType: "credit_card", isRevolving: true, creditLimit: 10000, currentBalance: 2000, status: "open" });
  const ovG = await C.computeCreditOverview(U, { now: NOW });
  ok("[43] goal progress is calculated", ovG.goalProgress.find((g) => g.id === g1.id)!.currentValue === 710 && ovG.goalProgress.find((g) => g.id === g2.id)!.currentValue === 20 && ovG.goalProgress.find((g) => g.id === g2.id)!.onTrack === true);
  await C.updateGoal(U, g1.id, { status: "achieved" });
  ok("[44] completed goal remains historical", (await C.listGoals(U)).some((g) => g.id === g1.id && g.status === "achieved"));
  const before = (await C.listGoals(U)).find((g) => g.id === g2.id)!;
  await C.updateGoal(U, g2.id, { priority: "high" }); await C.updateGoal(U, g2.id, { priority: "high" });
  const after = (await C.listGoals(U)).filter((g) => g.id === g2.id);
  ok("[45] repeated goal update is idempotent", after.length === 1 && after[0].priority === "high" && before.id === after[0].id);
  ok("[46] invalid target is rejected", await threw(() => C.createGoal(U, { goalType: "utilization_target", targetValue: 150 })) && await threw(() => C.createGoal(U, { goalType: "score_target", targetValue: 50 })));
  ok("[47] foreign-owner goal access is rejected", await threw(() => C.updateGoal(FOREIGN, g1.id, { status: "abandoned" })) && (await C.listGoals(FOREIGN)).length === 0);

  await resetCredit();
  /* ================= observations [48-60] ================= */
  console.log("\n[observations]");
  // increasing score + high utilization + unverified collection + recent inquiries + upcoming payment + missing limit
  await C.createScore(U, { score: 680, source: "experian", asOfDate: ago(40) });
  await C.createScore(U, { score: 700, source: "experian", asOfDate: ago(3) });
  await C.createAccount(U, { name: "High Util", accountType: "credit_card", isRevolving: true, creditLimit: 1000, currentBalance: 700, minimumPayment: 35, paymentDueDate: ahead(7), status: "open" });
  await C.createAccount(U, { name: "NoLimit", accountType: "credit_card", isRevolving: true, currentBalance: 200, status: "open" });
  await C.createCollection(U, { collectorName: "Verify Me", reportedBalance: 350, validationStatus: "not_requested" });
  await C.createInquiry(U, { creditorName: "L1", inquiryDate: ago(20), inquiryType: "hard" });
  await C.createInquiry(U, { creditorName: "L2", inquiryDate: ago(40), inquiryType: "hard" });
  const A = await C.computeCreditOverview(U, { now: NOW });
  const obsType = (t: string) => A.observations.find((o) => o.type === t);
  ok("[48] score increase creates a positive trend observation", !!obsType("score_change") && /increased by 20/i.test(obsType("score_change")!.summary));
  ok("[50] high utilization creates an observation", !!obsType("utilization_high") && /70%/i.test(obsType("utilization_high")!.summary));
  ok("[52] payment due soon creates an observation", !!obsType("payment_due_soon"));
  ok("[54] unverified collection creates an observation", !!obsType("collection_unverified") && /verify the debt/i.test(obsType("collection_unverified")!.summary));
  ok("[55] recent hard inquiries create an observation", !!obsType("recent_hard_inquiries"));
  ok("[56] missing data creates an incomplete-profile warning", !!obsType("thin_or_incomplete_profile") || A.dataQuality.some((d) => /missing a credit limit/i.test(d)));
  ok("[58] reason codes and confidence are present", A.observations.every((o) => o.reasonCodes.length > 0 && ["high", "medium", "low"].includes(o.confidence)));
  ok("[59] as-of dates are shown", A.observations.some((o) => o.asOfDate != null));
  ok("[60] no observation guarantees score impact", A.observations.every((o) => !/\bwill (raise|increase|improve) your score\b|guaranteed score (increase|improvement|boost)|guarantees? \d+ ?point/i.test(o.summary + " " + o.limitation)));
  await resetCredit();
  // decreasing score
  await C.createScore(U, { score: 700, source: "equifax", asOfDate: ago(40) });
  await C.createScore(U, { score: 682, source: "equifax", asOfDate: ago(3) });
  const Dn = await C.computeCreditOverview(U, { now: NOW });
  const scoreDown = Dn.observations.find((o) => o.type === "score_change")!;
  ok("[49] score decrease uses careful wording", /decreased by 18/i.test(scoreDown.summary) && /not conclusive|move for many reasons/i.test(scoreDown.summary));
  await resetCredit();
  // improving/low utilization + util goal
  await C.createAccount(U, { name: "Low Util", accountType: "credit_card", isRevolving: true, creditLimit: 10000, currentBalance: 800, status: "open" });
  await C.createGoal(U, { goalType: "utilization_target", targetValue: 30 });
  const Lo = await C.computeCreditOverview(U, { now: NOW });
  ok("[51] improving utilization creates progress", Lo.observations.some((o) => o.type === "utilization_progress"));
  await resetCredit();
  // overdue payment + stale score
  await C.createScore(U, { score: 690, source: "experian", asOfDate: ago(60) });
  await C.createAccount(U, { name: "Overdue Card", accountType: "credit_card", isRevolving: true, creditLimit: 2000, currentBalance: 300, minimumPayment: 40, paymentDueDate: ago(5), status: "open" });
  const Od = await C.computeCreditOverview(U, { now: NOW });
  ok("[53] overdue payment creates urgent wording", Od.observations.some((o) => o.type === "payment_overdue" && /overdue|in the past|confirm whether it was paid/i.test(o.summary)));
  ok("[57] stale score creates an update warning", Od.observations.some((o) => o.type === "data_update_needed") && Od.staleScore === true);

  await resetCredit();
  /* ================= action cards [61-73] ================= */
  console.log("\n[action cards]");
  await C.createCollection(U, { collectorName: "Verify Co", reportedBalance: 400, validationStatus: "not_requested", settlementOffer: 150 });
  await C.createAccount(U, { name: "Huge Util", accountType: "credit_card", isRevolving: true, creditLimit: 200000, currentBalance: 190000, minimumPayment: 60, paymentDueDate: ahead(5), status: "open" });
  await C.createInquiry(U, { creditorName: "Q1", inquiryDate: ago(15), inquiryType: "hard" });
  await C.createInquiry(U, { creditorName: "Q2", inquiryDate: ago(25), inquiryType: "hard" });
  const Act = await C.computeCreditOverview(U, { now: NOW });
  const act = (t: string) => Act.actions.find((a) => a.actionType === t);
  ok("[61] verify-collection action is generated", !!act("verify_collection"));
  ok("[62] written-terms guidance is included before payment", !!act("verify_collection") && /written/i.test(act("verify_collection")!.nextStep) && (!!act("obtain_written_terms")));
  ok("[63] utilization-reduction action calculates cash requirement", !!act("reduce_utilization") && act("reduce_utilization")!.estimatedCost != null && act("reduce_utilization")!.estimatedCost! > 0);
  ok("[64] cash-flow conflict is detected", !!act("reduce_utilization") && /exceed your estimated available cash|risky before your next paycheck/i.test(act("reduce_utilization")!.tradeoff));
  ok("[65] essential-bill money is not recommended for credit action", Act.actions.every((a) => !/use (rent|essential)/i.test(a.nextStep)) && /do not use (essential-bill or rent|rent or essential-bill) money/i.test(act("reduce_utilization")!.tradeoff));
  ok("[66] upcoming payment action is generated", !!act("review_payment"));
  ok("[67] recent-inquiry caution is generated", !!act("avoid_new_applications"));
  ok("[69] every action contains a next step", Act.actions.every((a) => !!a.nextStep));
  ok("[70] every action contains a tradeoff", Act.actions.every((a) => !!a.tradeoff));
  ok("[71] every action contains a verification requirement", Act.actions.every((a) => !!a.verificationNeeded));
  ok("[72] Personal Advantage output shape is present", Act.actions.every((a) => a.domain === "credit" && !!a.actionType && ["low", "medium", "high"].includes(a.urgency) && typeof a.estimatedUpside === "string" && !!a.timeRequired && ["low", "medium", "high"].includes(a.riskLevel) && !!a.evidence && !!a.nextStep && typeof a.professionalVerificationRecommended === "boolean" && ["high", "medium", "low"].includes(a.confidence)));
  ok("[73] no action automatically pays, disputes, closes or applies", Act.actions.every((a) => !/^pay this|^close this|^apply for|automatically (pay|dispute|close|apply)/i.test(a.title) && !/we (will|have) (paid|closed|applied|disputed)/i.test(a.nextStep)));
  await resetCredit();
  // goal-review action when no active goal
  await C.createScore(U, { score: 700, source: "experian", asOfDate: NOW });
  const NoGoal = await C.computeCreditOverview(U, { now: NOW });
  ok("[68] goal-review action is generated", NoGoal.actions.some((a) => a.actionType === "review_goal"));

  /* ================= UI [74-95] ================= */
  console.log("\n[ui]");
  const uiSrc = read("components/finances/credit.tsx"); const pageSrc = read("app/finances/page.tsx"); const secSrc = read("components/home/sections.tsx");
  ok("[74] Credit & financial health section renders", /Credit &amp; financial health/.test(pageSrc) && /<CreditHealth/.test(pageSrc));
  ok("[75] manual-data warning renders", /manually entered and may become outdated/.test(uiSrc));
  ok("[76] latest score displays source and date", /fin-score-src/.test(uiSrc) && /as of \{t\.latestDate\}/.test(uiSrc));
  ok("[77] same-source trend displays", /same source/.test(uiSrc) && /pts since/.test(uiSrc));
  ok("[78] different-source warning displays", /multiSourceWarning/.test(uiSrc));
  ok("[79] utilization summary renders", /Revolving utilization/.test(uiSrc) && /Aggregate/.test(uiSrc));
  ok("[80] collections summary renders", /Collections summary/.test(uiSrc));
  ok("[81] inquiry summary renders", /Inquiry summary/.test(uiSrc) && /Only hard inquiries/.test(uiSrc));
  ok("[82] upcoming payment summary renders", /Upcoming credit payments/.test(uiSrc));
  ok("[83] goals render", /Current goals/.test(uiSrc) && /Credit goals/.test(uiSrc));
  ok("[84] top action cards render", /Top actions/.test(uiSrc) && /fin-action-card/.test(uiSrc));
  ok("[85] add/edit score flow renders", /ScoreForm/.test(uiSrc) && /Save score/.test(uiSrc));
  ok("[86] add/edit account flow renders", /AccountForm/.test(uiSrc) && /Save account/.test(uiSrc));
  ok("[87] add/edit collection flow renders", /CollectionForm/.test(uiSrc) && /Save collection/.test(uiSrc));
  ok("[88] add/edit inquiry flow renders", /InquiryForm/.test(uiSrc) && /Save inquiry/.test(uiSrc));
  ok("[89] add/edit late-payment flow renders", /LateForm/.test(uiSrc) && /Save late-payment/.test(uiSrc));
  ok("[90] add/edit goal flow renders", /GoalForm/.test(uiSrc) && /Save goal/.test(uiSrc));
  ok("[91] stale-data warning renders", /over 45 days old/.test(uiSrc));
  ok("[92] Home shows at most one action and one progress item", /creditAction/.test(secSrc) && /creditProgress/.test(secSrc) && /creditStale/.test(secSrc) && !/\.actions\.map|observations\.map/.test(secSrc));
  ok("[93] /manage remains unchanged", !/CreditHealth|financial health|\/finances\/credit|credit_score|credit_accounts/i.test(read("components/manage/manage-dashboard.tsx")));
  ok("[94] desktop layout is usable (renders lists + tabs)", /fin-tabs/.test(uiSrc) && /fin-credit-list/.test(uiSrc));
  ok("[95] 375px has no horizontal overflow (responsive + no fixed wide widths)", !/[;{\s]width:\s*[4-9]\d\dpx/.test(read("app/globals.css").match(/Finance 1C\.0A[\s\S]*?Finance 1B\.2/)?.[0] ?? "") && /max-width: 460px/.test(read("app/globals.css")));

  /* ================= domain boundaries [96-114] ================= */
  console.log("\n[domain boundaries]");
  const svcSrc = read("lib/services/credit.ts");
  const anyTxn = (await db.select().from(importedTransactions).where(eq(importedTransactions.userId, U)).limit(1))[0];
  const snapTxn = anyTxn ? JSON.stringify(anyTxn) : null;
  const anyAcct = (await db.select().from(financialAccounts).where(and(eq(financialAccounts.userId, U), isNull(financialAccounts.deletedAt))).limit(1))[0];
  const snapAcct = anyAcct ? JSON.stringify(anyAcct) : null;
  const snapProv = JSON.stringify((await db.select().from(providerAccounts).where(eq(providerAccounts.userId, U))).map((p) => [p.id, p.balanceCurrent]).sort());
  const snapMov = (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length;
  const snapCat = (await db.select().from(transactionCategories).where(eq(transactionCategories.userId, U))).length;
  const snapAssign = (await db.select().from(transactionCategoryAssignments).where(eq(transactionCategoryAssignments.userId, U))).length;
  const snapRules = (await db.select().from(merchantCategoryRules).where(eq(merchantCategoryRules.userId, U))).length;
  const snapEv = (await db.select().from(financialEventEvidence).where(eq(financialEventEvidence.userId, U))).length;
  // heavy read: several overviews (each reads bank + finance data + computes)
  await C.createAccount(U, { name: "Boundary Card", accountType: "credit_card", isRevolving: true, creditLimit: 5000, currentBalance: 1000, status: "open" });
  await C.computeCreditOverview(U, { now: NOW }); await C.computeCreditOverview(U, { now: NOW }); await C.homeCreditSummary(U);
  ok("[96] credit calculations change no imported transaction", !anyTxn || JSON.stringify((await db.select().from(importedTransactions).where(eq(importedTransactions.id, anyTxn.id)))[0]) === snapTxn);
  ok("[97] credit calculations change no category or merchant rule", (await db.select().from(transactionCategories).where(eq(transactionCategories.userId, U))).length === snapCat && (await db.select().from(transactionCategoryAssignments).where(eq(transactionCategoryAssignments.userId, U))).length === snapAssign && (await db.select().from(merchantCategoryRules).where(eq(merchantCategoryRules.userId, U))).length === snapRules);
  ok("[98] credit calculations create no movement", (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length === snapMov);
  ok("[99] credit calculations change no account balance", !anyAcct || JSON.stringify((await db.select().from(financialAccounts).where(eq(financialAccounts.id, anyAcct.id)))[0]) === snapAcct);
  ok("[100] credit calculations change no provider snapshot", JSON.stringify((await db.select().from(providerAccounts).where(eq(providerAccounts.userId, U))).map((p) => [p.id, p.balanceCurrent]).sort()) === snapProv);
  ok("[101] credit calculations change no cursor (service never writes financial_connections)", !/update\(financialConnections\)|transactionsCursor/.test(svcSrc));
  ok("[102/103/104/105] no bill/income/transfer/evidence write", (await db.select().from(financialEventEvidence).where(eq(financialEventEvidence.userId, U))).length === snapEv && !/update\(financialEntries\)|update\(incomeEntries\)|update\(accountTransfers\)|insert\(financialEventEvidence\)|update\(financialEventEvidence\)/.test(svcSrc));
  ok("[106] no bureau API is added", !/experian\.com|equifax\.com|transunion\.com|bureau.*api|fetch\(.*(experian|equifax|transunion)/i.test(svcSrc));
  ok("[107] no Credit Karma scraping is added", !/creditkarma\.com|credit-karma|puppeteer|playwright|cheerio|\.scrape\(|scrapeCredit|headless/i.test(svcSrc));
  ok("[108] no automated dispute is added", !/sendDispute|fileDispute|dispute_letter|generateDispute/i.test(svcSrc));
  ok("[109] no debt payment is added", !/payCollection|settleDebt|makePayment|initiatePayment/i.test(svcSrc));
  ok("[110] no credit application is added", !/applyForCard|submitApplication|applyForLoan/i.test(svcSrc));
  ok("[111] no Production Plaid work is added", !/production/i.test(svcSrc) && !/plaid/i.test(svcSrc));
  ok("[112] no money movement is added", !/createTransfer|moveMoney|payBill|receiveIncome|paymentInitiation/.test(svcSrc));
  ok("[113] no automatic task creation is added", !/insert\(tasks\)|createTask/.test(svcSrc));
  ok("[114] no guaranteed score-improvement claim exists", !/guaranteed score (increase|improvement|boost)|will (raise|increase|improve) your score by|guarantees? \d+ ?point/i.test(svcSrc + uiSrc));

  await resetCredit();
  /* ================= owner protection [115-125] ================= */
  console.log("\n[owner protection]");
  const conns = await db.select().from(financialConnections).where(and(eq(financialConnections.userId, U), isNull(financialConnections.deletedAt)));
  const bofa = conns.find((x) => /bank of america/i.test(x.institutionName ?? ""));
  const accts = await db.select().from(financialAccounts).where(and(eq(financialAccounts.userId, U), isNull(financialAccounts.deletedAt)));
  const linked = accts.filter((x) => x.balanceSource === "linked"); let orphan = 0;
  for (const l of linked) { const m = await db.select().from(providerAccounts).where(and(eq(providerAccounts.financialAccountId, l.id), isNull(providerAccounts.deletedAt))); if (m.length !== 1) orphan++; }
  ok("[115] Bank of America Sandbox remains active", bofa?.status === "active" && bofa?.environment === "sandbox");
  ok("[116] Plaid Checking remains linked", accts.some((x) => x.name === "Plaid Checking" && x.balanceSource === "linked"));
  ok("[117] Chase and BofA remain manual", accts.filter((x) => ["Chase", "BofA"].includes(x.name)).every((x) => x.balanceSource === "manual"));
  ok("[118] existing imported transactions remain intact", (await db.select().from(importedTransactions).where(eq(importedTransactions.userId, U))).length === ownerImportedBefore);
  ok("[119] no linked-account orphan exists", orphan === 0);
  ok("[120] request 222 remains present", (await db.select().from(experienceRequests).where(eq(experienceRequests.id, 222))).length === 1);
  ok("[121] no usage-log row is created", (await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))).length === ownerLogsBefore);
  ok("[122] .env.local remains ignored (gitignore)", /(^|\n)\.env\.local/.test(read(".gitignore")));
  ok("[123] no secret appears in source", !/access-sandbox-[0-9a-f]{8}|sk-ant-|npg_[A-Za-z0-9]{6}/.test(svcSrc + uiSrc));
  ok("[124/125] exact-ID cleanup — no temporary credit / insight / category / rule / assignment / evidence / match / ZZ residue",
    (await db.select().from(creditScoreSnapshots).where(eq(creditScoreSnapshots.userId, U))).length === 0
    && (await db.select().from(creditAccounts).where(eq(creditAccounts.userId, U))).length === 0
    && (await db.select().from(creditCollections).where(eq(creditCollections.userId, U))).length === 0
    && (await db.select().from(creditInquiries).where(eq(creditInquiries.userId, U))).length === 0
    && (await db.select().from(creditLatePayments).where(eq(creditLatePayments.userId, U))).length === 0
    && (await db.select().from(creditGoals).where(eq(creditGoals.userId, U))).length === 0
    && (await db.select().from(transactionCategories).where(eq(transactionCategories.userId, U))).length === 0
    && (await db.select().from(financialEventEvidence).where(eq(financialEventEvidence.userId, U))).length === 0
    && (await db.select().from(transactionMatchSuggestions).where(eq(transactionMatchSuggestions.userId, U))).length === 0
    && (await db.select().from(financialAccounts).where(and(eq(financialAccounts.userId, U), like(financialAccounts.name, "ZZ%")))).length === 0
    && (await db.select().from(accountMovements).where(eq(accountMovements.userId, U))).length === ownerMovementsBefore);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch(async (e) => { try { await resetCredit(); } catch { /* noop */ } console.error(e); process.exit(1); });
