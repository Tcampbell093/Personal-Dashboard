/* Shared view-model types used by the dashboard UI and the briefing engine.
 * These are deliberately decoupled from the Drizzle row types so the UI does
 * not depend on the database shape. */

export type Tier = "act_today" | "be_aware" | "explore";

export type Priority = "low" | "medium" | "high" | "critical";

export interface TaskView {
  id: number;
  title: string;
  dueDate: string | null;
  dueTime: string | null;
  priority: Priority;
  status: string;
  category: string | null;
}

export interface ObligationView {
  id: number;
  title: string;
  type: string;
  startDate: string;
  startTime: string | null;
  location: string | null;
  importance: Priority;
  status: string;
}

export interface FinancialOutlook {
  accountsTotal: number;
  nextPaydayDate: string | null;
  expectedIncomeBeforePayday: number;
  billsDueBeforePayday: number;
  estimatedRemaining: number;
  overdueCount: number;
  due7: number;
  due14: number;
  due30: number;
}

export interface AccountView {
  id: number;
  name: string;
  type: string;
  currentBalance: number;
}

export interface BillView {
  id: number;
  name: string;
  expectedAmount: number;
  dueDate: string | null;
  status: string;
}

export interface IncomeView {
  id: number;
  source: string;
  expectedAmount: number;
  payDate: string;
  isPayday: boolean;
}

export interface SignalView {
  id: number;
  title: string;
  type: string;
  location: string | null;
  eventDate: string | null;
  expirationDate: string | null;
  urgencyScore: number | null;
  relevanceScore: number | null;
  status: string;
  isMock: boolean;
}

export interface OpportunityView {
  id: number;
  title: string;
  summary: string | null;
  category: string;
  timeWindowEnd: string | null;
  confidenceScore: number | null;
  potentialValue: number | null;
  estimatedRisk: Priority | null;
  status: string;
}

export interface JobView {
  id: number;
  title: string;
  company: string | null;
  location: string | null;
  matchScore: number | null;
  workArrangement: string | null;
  status: string;
  isMock: boolean;
}

export interface InterestItemView {
  id: number;
  topic: string;
  title: string;
  source: string | null;
  relevanceScore: number | null;
  status: string;
  isMock: boolean;
}

export interface Briefing {
  date: string;
  summary: string;
  mostImportantTask: string;
  mostImportantObligation: string;
  mostRelevantOpportunity: string;
  warning: string | null;
}

export interface DashboardData {
  briefing: Briefing;
  tasks: TaskView[];
  obligations: ObligationView[];
  finances: FinancialOutlook;
  accounts: AccountView[];
  bills: BillView[];
  income: IncomeView[];
  signals: SignalView[];
  opportunities: OpportunityView[];
  jobs: JobView[];
  interest: InterestItemView[];
  usingMockData: boolean;
  // True once that section is read from the real database (others may still be mock).
  tasksLive: boolean;
  obligationsLive: boolean;
  financesLive: boolean;
  signalsLive: boolean;
  opportunitiesLive: boolean;
  jobsLive: boolean;
  interestLive: boolean;
}
