/* Dashboard data loader.
 *
 * Phase 1: returns clearly-labeled MOCK data so the home screen renders with no
 * database. The shape it returns (DashboardData) is the contract the UI depends
 * on, so swapping in real queries later changes nothing in the components.
 *
 * To go live: set DATABASE_URL, run migrations + seed, then replace the mock
 * block below with calls to the service layer (listTasks, listObligations, ...)
 * and the financial calculation in lib/services/finances.ts. */

import type { DashboardData } from "@/lib/types";
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

export async function loadDashboard(): Promise<DashboardData> {
  // --- Phase 1: mock data path ------------------------------------------
  const usingMockData = true;

  const briefing = generateBriefing({
    tasks: mockTasks,
    obligations: mockObligations,
    opportunities: mockOpportunities,
    finances: mockFinances,
  });

  return {
    briefing,
    tasks: mockTasks,
    obligations: mockObligations,
    finances: mockFinances,
    signals: mockSignals,
    opportunities: mockOpportunities,
    jobs: mockJobs,
    interest: mockInterest,
    usingMockData,
  };

  /* --- Future real-data path (kept here as the wiring guide) -------------
  const userId = await getCurrentUserId();
  const [tasks, obligations, finances, signals, opportunities, jobs, interest] =
    await Promise.all([
      listTasks(userId).then(toTaskViews),
      listObligations(userId).then(toObligationViews),
      computeFinancialOutlook(userId),
      listActiveSignals(userId).then(toSignalViews),
      listOpportunities(userId).then(toOpportunityViews),
      listJobs(userId).then(toJobViews),
      listInterestItems(userId).then(toInterestViews),
    ]);
  const briefing = generateBriefing({ tasks, obligations, opportunities, finances });
  return { briefing, tasks, obligations, finances, signals, opportunities,
           jobs, interest, usingMockData: false };
  ------------------------------------------------------------------------- */
}
