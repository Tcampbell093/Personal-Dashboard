/* Dashboard data loader.
 *
 * Phase 1: returns clearly-labeled MOCK data so the home screen renders with no
 * database. The shape it returns (DashboardData) is the contract the UI depends
 * on, so swapping in real queries later changes nothing in the components.
 *
 * To go live: set DATABASE_URL, run migrations + seed, then replace the mock
 * block below with calls to the service layer (listTasks, listObligations, ...)
 * and the financial calculation in lib/services/finances.ts. */

import type { DashboardData, TaskView, ObligationView } from "@/lib/types";
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
  }

  const briefing = generateBriefing({
    tasks,
    obligations,
    opportunities: mockOpportunities,
    finances: mockFinances,
  });

  return {
    briefing,
    tasks,
    obligations,
    finances: mockFinances,
    signals: mockSignals,
    opportunities: mockOpportunities,
    jobs: mockJobs,
    interest: mockInterest,
    // Remaining sections are still mock in this phase.
    usingMockData: true,
    tasksLive,
    obligationsLive,
  };
}
