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

/* --- Experience and Adventure Loop v1 (Build 1, manual) ------------------- */

export type ExperienceRequestStatus =
  | "draft"
  | "interpreted"
  | "recommendations_ready"
  | "planned";
export type ExperienceInterpretationSource = "manual" | "ai";

/* Build 2B.1: an application-owned, validated experience recommendation. The
 * `id` is assigned by the application after the whole batch passes validation
 * (the model never controls ids). These are concepts, not verified facts. */
export interface ExperienceRecommendation {
  id: string; // app-assigned opaque id, e.g. "rec_<uuid>"
  title: string;
  description: string;
  whyItFits: string;
  estimatedCostMin: number | null;
  estimatedCostMax: number | null;
  estimatedDurationMinutes: number | null;
  locationText: string | null;
  travelAssumption: string | null;
  physicalDifficulty: PhysicalDifficulty | null;
  intendedFeeling: string | null;
  assumptions: string[];
  preparationNotes: string[];
}
export type ExperienceStatus =
  | "planned"
  | "completed"
  | "cancelled"
  | "not_completed";
export type EnergyLevel = "low" | "medium" | "high";
export type PhysicalDifficulty = "easy" | "moderate" | "challenging";

export interface ExperienceRequestView {
  id: number;
  requestText: string;
  availableDate: string | null;
  availableTimeText: string | null;
  budgetMax: number | null;
  startingLocation: string | null;
  maxTravelMiles: number | null;
  maxTravelMinutes: number | null;
  energyLevel: EnergyLevel | null;
  desiredFeeling: string | null;
  maxPhysicalDifficulty: PhysicalDifficulty | null;
  interests: string[];
  exclusions: string[];
  status: ExperienceRequestStatus;
  interpretationSource: ExperienceInterpretationSource;
  // Build 2B.1: validated recommendation batch + how it was produced (`ai` or
  // null). Empty array when none generated or after a clear-on-edit.
  recommendations: ExperienceRecommendation[];
  recommendationSource: ExperienceInterpretationSource | null;
}

export interface ExperienceView {
  id: number;
  requestId: number;
  title: string;
  description: string | null;
  plannedDate: string | null;
  plannedTimeText: string | null;
  locationText: string | null;
  expectedCost: number | null;
  actualCost: number | null;
  expectedDurationMinutes: number | null;
  physicalDifficulty: PhysicalDifficulty | null;
  desiredFeeling: string | null;
  notes: string | null;
  status: ExperienceStatus;
  nonCompletionReason: string | null;
  rating: number | null;
  reflection: string | null;
  meaningfulExperience: boolean;
  adventureXp: number;
  resolvedAt: string | null;
}

export interface ExperienceXpSummary {
  total: number;
  completedCount: number;
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
