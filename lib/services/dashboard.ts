/* Dashboard data loader.
 *
 * Phase 1: returns clearly-labeled MOCK data so the home screen renders with no
 * database. The shape it returns (DashboardData) is the contract the UI depends
 * on, so swapping in real queries later changes nothing in the components.
 *
 * To go live: set DATABASE_URL, run migrations + seed, then replace the mock
 * block below with calls to the service layer (listTasks, listObligations, ...)
 * and the financial calculation in lib/services/finances.ts. */

import type {
  DashboardData,
  TaskView,
  ObligationView,
  FinancialOutlook,
  AccountView,
  BillView,
  IncomeView,
  SignalView,
  OpportunityView,
  JobView,
  InterestItemView,
} from "@/lib/types";
import {
  mockTasks,
  mockObligations,
  mockFinances,
  mockSignals,
  mockOpportunities,
  mockJobs,
  mockInterest,
} from "@/lib/mock-data";
import { generateBriefing } from "@/lib/briefing";
import { getCurrentUserId } from "@/lib/auth";
import { listTasks, toTaskViews } from "@/lib/services/tasks";
import { listObligations, toObligationViews } from "@/lib/services/obligations";
import {
  computeFinancialOutlook,
  listAccounts,
  listBills,
  listIncome,
  toAccountViews,
  toBillViews,
  toIncomeViews,
} from "@/lib/services/finances";
import { listSignals, toSignalViews } from "@/lib/services/signals";
import { listOpportunities, toOpportunityViews } from "@/lib/services/opportunities";
import { listJobs, toJobViews } from "@/lib/services/jobs";
import { listInterestItems, toInterestViews } from "@/lib/services/interest";

export async function loadDashboard(): Promise<DashboardData> {
  // Phase 2: TASKS and OBLIGATIONS are wired to the real database. The rest
  // (finances, signals, …) is still mock until each vertical is wired the same
  // way. Each section goes live as soon as DATABASE_URL is configured; with no
  // DB the dashboard still renders entirely on mock data.
  const dbConfigured = Boolean(process.env.DATABASE_URL);
  const userId = dbConfigured ? await getCurrentUserId() : null;

  let tasks: TaskView[] = mockTasks;
  let tasksLive = false;
  let obligations: ObligationView[] = mockObligations;
  let obligationsLive = false;
  let finances: FinancialOutlook = mockFinances;
  let accounts: AccountView[] = [];
  let bills: BillView[] = [];
  let income: IncomeView[] = [];
  let financesLive = false;
  let signals: SignalView[] = mockSignals;
  let signalsLive = false;
  let opportunities: OpportunityView[] = mockOpportunities;
  let opportunitiesLive = false;
  let jobs: JobView[] = mockJobs;
  let jobsLive = false;
  let interest: InterestItemView[] = mockInterest;
  let interestLive = false;

  if (userId !== null) {
    try {
      tasks = toTaskViews(await listTasks(userId));
      tasksLive = true;
    } catch (err) {
      // Never let a DB hiccup blank the dashboard — fall back to mock data.
      console.error("loadDashboard: task query failed, using mock tasks.", err);
    }
    try {
      obligations = toObligationViews(await listObligations(userId));
      obligationsLive = true;
    } catch (err) {
      console.error(
        "loadDashboard: obligation query failed, using mock obligations.",
        err,
      );
    }
    try {
      [finances, accounts, bills, income] = await Promise.all([
        computeFinancialOutlook(userId),
        listAccounts(userId).then(toAccountViews),
        listBills(userId).then(toBillViews),
        listIncome(userId).then(toIncomeViews),
      ]);
      financesLive = true;
    } catch (err) {
      console.error("loadDashboard: finance query failed, using mock finances.", err);
    }
    try {
      signals = toSignalViews(await listSignals(userId));
      signalsLive = true;
    } catch (err) {
      console.error("loadDashboard: signal query failed, using mock signals.", err);
    }
    try {
      opportunities = toOpportunityViews(await listOpportunities(userId));
      opportunitiesLive = true;
    } catch (err) {
      console.error("loadDashboard: opportunity query failed, using mock.", err);
    }
    try {
      jobs = toJobViews(await listJobs(userId));
      jobsLive = true;
    } catch (err) {
      console.error("loadDashboard: job query failed, using mock jobs.", err);
    }
    try {
      interest = toInterestViews(await listInterestItems(userId));
      interestLive = true;
    } catch (err) {
      console.error("loadDashboard: interest query failed, using mock.", err);
    }
  }

  const briefing = generateBriefing({
    tasks,
    obligations,
    opportunities,
    finances,
  });

  // Banner shows whenever any vertical is still falling back to mock data.
  const anyMock =
    !tasksLive ||
    !obligationsLive ||
    !financesLive ||
    !signalsLive ||
    !opportunitiesLive ||
    !jobsLive ||
    !interestLive;

  return {
    briefing,
    tasks,
    obligations,
    finances,
    accounts,
    bills,
    income,
    signals,
    opportunities,
    jobs,
    interest,
    usingMockData: anyMock,
    tasksLive,
    obligationsLive,
    financesLive,
    signalsLive,
    opportunitiesLive,
    jobsLive,
    interestLive,
  };
}
