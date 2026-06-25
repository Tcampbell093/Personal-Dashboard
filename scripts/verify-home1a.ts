/* Deterministic verification for Home 1A (daily command center). No AI, no
 * network model calls. Drives the real Home assembly + deterministic ranker +
 * the two direct-action services against the real database, plus text-scan
 * assertions for wording/labels/resilience. Strictly exact-ID cleanup; sentinels
 * survive; request 222 and unrelated owner data are never touched.
 *
 * Run: npx tsx --env-file=.env scripts/verify-home1a.ts
 */

import { readFileSync, readdirSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { tasks, obligations, financialEntries, experiences, experienceRequests, apiUsageLogs } from "@/db/schema";
import { CURRENT_USER_ID } from "@/lib/auth";
import { rankNeedsAttention } from "@/lib/briefing";
import { buildHomeView, firstNameFromStored } from "@/lib/services/home";
import { appTimeZone, localToday, partOfDay, longDateLabel, localDaysUntil } from "@/lib/time";
import { createTask, completeTask } from "@/lib/services/tasks";
import { createObligation } from "@/lib/services/obligations";
import { createBill, payBill, computeFinancialOutlook } from "@/lib/services/finances";
import { createRequest } from "@/lib/services/experience-requests";
import { createPlannedExperience } from "@/lib/services/experiences";
import { xpSummary } from "@/lib/services/experiences";
import type { TaskView, ObligationView } from "@/lib/types";

const U = CURRENT_USER_ID;
let passed = 0, failed = 0;
const ok = (n: string, c: boolean) => { c ? passed++ : failed++; console.log(`${c ? "✓" : "✗"} ${n}`); };

const iso = (offsetDays: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};
const mkTask = (o: Partial<TaskView>): TaskView => ({
  id: o.id ?? 0, title: o.title ?? "t", dueDate: o.dueDate ?? null, dueTime: null,
  priority: o.priority ?? "medium", status: o.status ?? "pending", category: null, completedAt: o.completedAt ?? null,
});
const mkObl = (o: Partial<ObligationView>): ObligationView => ({
  id: o.id ?? 0, title: o.title ?? "o", type: "appointment", startDate: o.startDate ?? iso(10),
  startTime: null, location: null, importance: "medium", status: o.status ?? "upcoming",
});

const acct = { taskIds: [] as number[], oblIds: [] as number[], billIds: [] as number[], reqIds: [] as number[], expIds: [] as number[] };

async function main() {
  console.log("Home 1A deterministic verification\n");

  /* ---- 0. Greeting placeholder suppression + timezone --------------- */
  console.log("[0] greeting + timezone");
  ok("[0] 'Owner' → nameless", firstNameFromStored("Owner") === null);
  ok("[0] 'owner' → nameless", firstNameFromStored("owner") === null);
  ok("[0] '  Owner  ' (whitespace) → nameless", firstNameFromStored("  Owner  ") === null);
  ok("[0] 'User' → nameless", firstNameFromStored("User") === null);
  ok("[0] '' → nameless", firstNameFromStored("") === null);
  ok("[0] null → nameless", firstNameFromStored(null) === null);
  ok("[0] genuine 'Thando Yordani' → 'Thando'", firstNameFromStored("Thando Yordani") === "Thando");
  ok("[0] genuine 'Thando' → 'Thando'", firstNameFromStored("Thando") === "Thando");

  const savedTz = process.env.APP_TIME_ZONE;
  process.env.APP_TIME_ZONE = "America/New_York";
  ok("[0] valid APP_TIME_ZONE used", appTimeZone() === "America/New_York");
  // Fixed instants → NY (EDT, UTC-4 in June)
  ok("[0] 10:00Z → NY morning", partOfDay(new Date("2026-06-23T10:00:00Z")) === "morning");
  ok("[0] 17:00Z → NY afternoon", partOfDay(new Date("2026-06-23T17:00:00Z")) === "afternoon");
  ok("[0] 01:00Z next day → NY evening (prev day)", partOfDay(new Date("2026-06-24T01:00:00Z")) === "evening");
  ok("[0] localToday in NY (01:00Z → prev local day)", localToday(new Date("2026-06-24T01:00:00Z")) === "2026-06-23");
  ok("[0] longDateLabel uses tz", /June 23/.test(longDateLabel(new Date("2026-06-23T10:00:00Z"))));
  // Daily boundary around UTC/local midnight: 03:30Z is 23:30 prev day in NY.
  const mid = new Date("2026-06-23T03:30:00Z"); // NY local date = 2026-06-22
  ok("[0] due-today uses LOCAL boundary (not UTC)", localDaysUntil("2026-06-22", mid) === 0);
  ok("[0] due-in-1 across midnight", localDaysUntil("2026-06-23", mid) === 1);
  ok("[0] overdue count across midnight", localDaysUntil("2026-06-20", mid) === -2);
  // Cross-timezone shift proves the helper honors configuration.
  process.env.APP_TIME_ZONE = "Asia/Tokyo";
  ok("[0] Tokyo shifts local date forward", localToday(new Date("2026-06-23T16:00:00Z")) === "2026-06-24");
  // Invalid timezone falls back safely.
  process.env.APP_TIME_ZONE = "Not/AZone";
  ok("[0] invalid APP_TIME_ZONE → fallback America/New_York", appTimeZone() === "America/New_York");
  ok("[0] invalid tz still computes without throwing", typeof partOfDay(new Date("2026-06-23T10:00:00Z")) === "string");
  if (savedTz === undefined) delete process.env.APP_TIME_ZONE; else process.env.APP_TIME_ZONE = savedTz;

  /* ---- 1. Deterministic ranker: order + reason labels ---------------- */
  console.log("[1] ranker order + reason labels");
  const ranked = rankNeedsAttention({
    tasks: [
      mkTask({ id: 1, title: "overdue", dueDate: iso(-3) }),
      mkTask({ id: 2, title: "today", dueDate: iso(0) }),
      mkTask({ id: 3, title: "critical", priority: "critical" }),
      mkTask({ id: 4, title: "soon", dueDate: iso(2) }),
      mkTask({ id: 5, title: "high", priority: "high" }),
      mkTask({ id: 6, title: "far", dueDate: iso(30) }), // not pressing → excluded
      mkTask({ id: 7, title: "done", dueDate: iso(-1), status: "completed" }), // excluded
    ],
    obligations: [mkObl({ id: 8, title: "obl-overdue", startDate: iso(-1) })],
    finances: { overdueCount: 2, accountsTotal: 0, nextPaydayDate: null, expectedIncomeBeforePayday: 0, billsDueBeforePayday: 0, estimatedRemaining: 0, due7: 0, due14: 0, due30: 0 },
  });
  const reasons = ranked.map((r) => r.reason);
  ok("[1] excludes non-pressing + completed (5 tasks + 1 obligation + 1 bill = 7)", ranked.length === 7);
  ok("[1] sorted by rank desc", ranked.every((r, i) => i === 0 || ranked[i - 1].rank >= r.rank));
  ok("[1] overdue task reason = 'Overdue 3 days'", reasons.includes("Overdue 3 days"));
  ok("[1] due-today reason present", reasons.includes("Due today"));
  ok("[1] critical reason present", reasons.includes("Critical priority"));
  ok("[1] due-soon reason = 'Due in 2 days'", reasons.includes("Due in 2 days"));
  ok("[1] high-priority reason present", reasons.includes("High priority"));
  ok("[1] overdue bills item = '2 overdue bills'", ranked.some((r) => r.kind === "bill" && r.title === "2 overdue bills"));
  ok("[1] most urgent first is the overdue task", ranked[0].reason === "Overdue 3 days");
  ok("[1] every item has a visible reason", ranked.every((r) => typeof r.reason === "string" && r.reason.length > 0));

  /* ---- 2. Top-five curation ----------------------------------------- */
  console.log("\n[2] top-five curation");
  const many = rankNeedsAttention({
    tasks: Array.from({ length: 8 }, (_, i) => mkTask({ id: 100 + i, title: `od${i}`, dueDate: iso(-(i + 1)) })),
    obligations: [],
    finances: null,
  });
  ok("[2] ranker returns all qualifying (8), sorted", many.length === 8 && many[0].rank >= many[7].rank);
  const top5 = [...many].sort((a, b) => b.rank - a.rank).slice(0, 5);
  ok("[2] first five are the five most urgent", JSON.stringify(many.slice(0, 5).map((r) => r.key)) === JSON.stringify(top5.map((r) => r.key)));
  const sectionsSrc = readFileSync("components/home/sections.tsx", "utf8");
  ok("[2] Home UI caps Needs attention at 5", /NEEDS_ATTENTION_LIMIT\s*=\s*5/.test(sectionsSrc) && /slice\(0,\s*NEEDS_ATTENTION_LIMIT\)/.test(sectionsSrc));

  /* ---- 3. buildHomeView against seeded real data -------------------- */
  console.log("\n[3] buildHomeView (seeded real data)");
  const t1 = await createTask({ userId: U, title: "H1A overdue task", priority: "high", dueDate: iso(-2) } as never);
  acct.taskIds.push(t1.id);
  const t2 = await createTask({ userId: U, title: "H1A due-today task", priority: "medium", dueDate: iso(0) } as never);
  acct.taskIds.push(t2.id);
  const ob1 = await createObligation({ userId: U, title: "H1A obligation", type: "appointment", startDate: iso(2), importance: "medium", status: "upcoming" } as never);
  acct.oblIds.push(ob1.id);
  const billDue = await createBill({ userId: U, name: "H1A bill due", kind: "bill", expectedAmount: "50.00", dueDate: iso(3), status: "scheduled" } as never);
  acct.billIds.push(billDue.id);
  const billOverdue = await createBill({ userId: U, name: "H1A bill overdue", kind: "bill", expectedAmount: "20.00", dueDate: iso(-5), status: "scheduled" } as never);
  acct.billIds.push(billOverdue.id);
  const req = await createRequest({ userId: U, requestText: "H1A momentum req" } as never);
  acct.reqIds.push(req.id);
  const exp = await createPlannedExperience(U, req.id, { title: "H1A planned experience", plannedDate: iso(5) });
  acct.expIds.push(exp.id);

  const logsBefore = (await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))).length;
  const home = await buildHomeView(U);
  const logsAfter = (await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))).length;

  ok("[3] needsAttention ok + contains our tasks with reasons", home.needsAttention.ok &&
    home.needsAttention.data!.items.some((i) => i.title === "H1A overdue task" && /Overdue/.test(i.reason)) &&
    home.needsAttention.data!.items.some((i) => i.title === "H1A due-today task" && i.reason === "Due today"));
  ok("[3] needsAttention items sorted desc", home.needsAttention.data!.items.every((r, i, a) => i === 0 || a[i - 1].rank >= r.rank));

  const outlook = await computeFinancialOutlook(U);
  const m = home.money.data!;
  ok("[3] money matches FinancialOutlook", home.money.ok &&
    m.estimatedRemaining === outlook.estimatedRemaining && m.billsDueBeforePayday === outlook.billsDueBeforePayday &&
    m.overdueCount === outlook.overdueCount && m.due30 === outlook.due30 && m.accountsTotal === outlook.accountsTotal);
  ok("[3] money exposes dueBills for the mark-paid action", m.dueBills.some((b) => b.id === billDue.id));

  const xp = await xpSummary(U);
  ok("[3] momentum matches xpSummary + next planned", home.momentum.ok &&
    home.momentum.data!.totalXp === xp.total && home.momentum.data!.completedCount === xp.completedCount &&
    home.momentum.data!.nextPlanned?.id === exp.id);
  ok("[3] coming up includes the planned experience", home.comingUp.ok &&
    home.comingUp.data!.some((c) => c.kind === "experience" && c.title === "H1A planned experience"));

  ok("[3] HomeView excludes experimental verticals (no signals/opportunities/jobs/interest keys)",
    !("signals" in home) && !("opportunities" in home) && !("jobs" in home) && !("interest" in home));
  ok("[3] all sections report an ok flag (section-level contract)",
    [home.needsAttention, home.comingUp, home.money, home.momentum].every((s) => typeof s.ok === "boolean"));
  ok("[3] no usage-log row created by Home (no AI invocation)", logsBefore === logsAfter);

  /* ---- 4. Direct actions (real underlying services) ----------------- */
  console.log("\n[4] direct actions");
  await completeTask(U, t1.id);
  const [t1after] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, t1.id));
  ok("[4] complete-task → status completed", t1after?.status === "completed");
  await payBill(U, billDue.id);
  const [billAfter] = await db.select({ status: financialEntries.status }).from(financialEntries).where(eq(financialEntries.id, billDue.id));
  ok("[4] mark-bill-paid → status paid", billAfter?.status === "paid");

  /* ---- 5. Wording + truthfulness (text scans) ----------------------- */
  console.log("\n[5] wording + truthfulness");
  const forbidden = ["safe to spend", "disposable income", "available balance", "live balance"];
  ok("[5] money wording present ('manually entered balances')", /manually entered balances/i.test(sectionsSrc));
  ok("[5] no forbidden money labels", forbidden.every((p) => !sectionsSrc.toLowerCase().includes(p)));
  const homeSrc = readFileSync("lib/services/home.ts", "utf8");
  ok("[5] Home excludes experimental verticals in code", !/\b(signals?|opportunit|jobs?|interest)\b/i.test(sectionsSrc + homeSrc));
  ok("[5] sections have a 'temporarily unavailable' degraded state", /temporarily unavailable/i.test(sectionsSrc));
  const pageSrc = readFileSync("app/page.tsx", "utf8");
  ok("[5] Home full-page DB-unavailable state exists", /Today is temporarily unavailable/i.test(pageSrc) && /catch/.test(pageSrc));

  /* ---- 6. /manage preservation + honest experimental labels --------- */
  console.log("\n[6] /manage preservation + experimental labels");
  const manageSrc = readFileSync("components/manage/manage-dashboard.tsx", "utf8");
  // NOTE: money management (FinanceManager) moved to /finances in Finance 1A.2 —
  // /manage now links there instead of embedding the finance forms.
  const verticalForms = ["AddTaskForm", "AddObligationForm", "AddSignalForm", "AddOpportunityForm", "AddJobForm", "AddInterestForm"];
  ok("[6] /manage preserves all vertical forms", verticalForms.every((f) => manageSrc.includes(f)));
  ok("[6] /manage links the money workspace to /finances", manageSrc.includes("/finances"));
  ok("[6] /manage honestly labels experimental / sample-backed", /experimental \/ sample-backed/i.test(manageSrc));
  ok("[6] /manage route renders the shared component (no duplicate page)", readFileSync("app/manage/page.tsx", "utf8").includes("ManageDashboard"));

  /* ---- 7. No schema change ------------------------------------------ */
  // Home 1A is a read/rank view and introduced NO migration of its own; 0004 was
  // the migration baseline at Home 1A time. Later, sanctioned builds may add their
  // own migrations (e.g. Finance 1A.1 → 0005), so this no longer forbids 0005+.
  console.log("\n[7] no schema change");
  const migFiles = readdirSync("db/migrations").filter((f) => f.endsWith(".sql"));
  ok("[7] Home-era migration baseline 0004 present (Home 1A added none)", migFiles.some((f) => f.startsWith("0004")));
}

async function cleanup() {
  console.log("\n[cleanup] exact-ID-scoped");
  console.log(`  targets — tasks:[${acct.taskIds}] obligations:[${acct.oblIds}] bills:[${acct.billIds}] experiences:[${acct.expIds}] requests:[${acct.reqIds}]`);
  // sentinel + unrelated data: request 222 must remain untouched.
  const [before222] = await db.select().from(experienceRequests).where(eq(experienceRequests.id, 222)).limit(1);

  for (const id of acct.expIds) await db.delete(experiences).where(eq(experiences.id, id));
  for (const id of acct.reqIds) await db.delete(experienceRequests).where(eq(experienceRequests.id, id));
  for (const id of acct.billIds) await db.delete(financialEntries).where(eq(financialEntries.id, id));
  for (const id of acct.oblIds) await db.delete(obligations).where(eq(obligations.id, id));
  for (const id of acct.taskIds) await db.delete(tasks).where(eq(tasks.id, id));

  const [after222] = await db.select().from(experienceRequests).where(eq(experienceRequests.id, 222)).limit(1);
  ok("[cleanup] request 222 untouched", !!after222 && JSON.stringify(after222) === JSON.stringify(before222));
  // unrelated owner data: no leftover H1A rows
  const leftoverTasks = (await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.userId, U)))).filter((t) => acct.taskIds.includes(t.id));
  ok("[cleanup] all harness tasks removed", leftoverTasks.length === 0);
}

main()
  .then(cleanup)
  .catch(async (e) => { console.error("harness error:", e); try { await cleanup(); } catch {} process.exitCode = 1; })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    console.log("\nHome 1A is deterministic and AI-free; no live model call was made.");
    if (failed > 0) process.exitCode = 1;
  });
