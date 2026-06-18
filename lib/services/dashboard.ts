/* Dashboard data loader.
 *
 * Phase 1: returns clearly-labeled MOCK data so the home screen renders with no
 * database. The shape it returns (DashboardData) is the contract the UI depends
 * on, so swapping in real queries later changes nothing in the components.
 *
 * To go live: set DATABASE_URL, run migrations + seed, then replace the mock
 * block below with calls to the service layer (listTasks, listObligations, ...)
 * and the financial calculation in lib/services/finances.ts. */

import type { DashboardData, TaskView } from "@/lib/types";
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

export async function loadDashboard(): Promise<DashboardData> {
  // Phase 2, step 1: TASKS are wired to the real database. The rest of the
  // dashboard (obligations, finances, signals, …) is still mock until each
  // vertical is wired the same way. Tasks go live as soon as DATABASE_URL is
  // configured; with no DB the dashboard still renders entirely on mock data.
  const dbConfigured = Boolean(process.env.DATABASE_URL);

  let tasks: TaskView[] = mockTasks;
  let tasksLive = false;
  if (dbConfigured) {
    try {
      const userId = await getCurrentUserId();
      tasks = toTaskViews(await listTasks(userId));
      tasksLive = true;
    } catch (err) {
      // Never let a DB hiccup blank the dashboard — fall back to mock tasks.
      console.error("loadDashboard: task query failed, using mock tasks.", err);
    }
  }

  const briefing = generateBriefing({
    tasks,
    obligations: mockObligations,
    opportunities: mockOpportunities,
    finances: mockFinances,
  });

  return {
    briefing,
    tasks,
    obligations: mockObligations,
    finances: mockFinances,
    signals: mockSignals,
    opportunities: mockOpportunities,
    jobs: mockJobs,
    interest: mockInterest,
    // Non-task sections remain mock in this phase.
    usingMockData: true,
    tasksLive,
  };
}
