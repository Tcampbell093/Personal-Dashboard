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
  completedAt: string | null;
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
  type: string; // checking | savings | cash | credit | other
  institution: string | null;
  purpose: string; // spending | bills | savings | emergency | cash | other
  currentBalance: number; // manually entered actual balance (credit = amount owed)
  balanceSource: string; // manual | linked (always "manual" in 1A.1)
  includeInSpendable: boolean;
  active: boolean;
  // True for checking/savings/cash; false for credit (a liability) and other.
  isCash: boolean;
  isLiability: boolean; // true for credit accounts
  lastReconciledAt: string | null; // Finance 1A.3B: when last verified vs the bank (ISO)
}

/** Finance 1A.1 cash/liability rollups. Every figure is from manually entered
 * actual balances — never a projection, never "safe to spend". Credit balances
 * are liabilities and are NEVER added to any cash total. */
export interface CashSummary {
  totalActualCash: number; // active cash-type accounts (assets)
  spendableActualCash: number; // active cash-type accounts with includeInSpendable
  savingsEmergency: number; // active accounts whose purpose is savings/emergency
  creditLiabilities: number; // active credit accounts (amount owed, positive)
  netPosition: number; // totalActualCash − creditLiabilities (informational)
  cashAccountCount: number;
  creditAccountCount: number;
}

export interface BillView {
  id: number;
  name: string;
  expectedAmount: number;
  dueDate: string | null;
  status: string;
  sourceAccountId: number | null; // account normally paid from (null = unassigned)
  paidAccountId: number | null; // account actually used when marked paid
  actualAmount: number | null; // Finance 1A.3A: confirmed amount actually paid
  paidAt: string | null; // Finance 1A.3A: when it was marked paid (ISO)
}

/** One append-only entry in the account-movements ledger. `amount` is signed
 * (negative = money left the account, positive = money entered). Finance 1A.2
 * adds income receipt + transfer kinds and their income/transfer references. */
export interface MovementView {
  id: number;
  accountId: number;
  accountName: string | null;
  billId: number | null;
  billName: string | null;
  incomeId: number | null;
  incomeSource: string | null;
  transferId: number | null;
  kind: string; // bill_payment(_reversal) | income_received | income_reversal | transfer_(out|in)(_reversal) | reconcile_(adjustment|reversal)
  amount: number; // signed
  priorBalance: number | null; // Finance 1A.3B: reconcile audit (balance before)
  newBalance: number | null; // Finance 1A.3B: reconcile audit (balance after)
  occurredAt: string; // ISO
}

/* --- Finance 1A.3B: account-aware projection (deterministic forecast) -------- */

export type ProjectionHorizon = "7d" | "payday" | "30d";

/** Per-account actual vs projected balance within the selected horizon. */
export interface AccountProjection {
  accountId: number;
  name: string;
  type: string;
  balanceSource: string;
  isCash: boolean;
  isLiability: boolean;
  includeInSpendable: boolean;
  purpose: string;
  actualBalance: number;
  scheduledInflows: number; // within horizon (manual accounts only)
  scheduledOutflows: number;
  projectedBalance: number; // actual + inflows − outflows
  belowZero: boolean; // projected < 0
}

/** One dated event in the forecast timeline. `amount` is signed for the account. */
export interface ForecastItem {
  date: string | null;
  kind: string; // income | bill | transfer_out | transfer_in
  accountId: number | null;
  accountName: string | null;
  amount: number;
  label: string;
  resultingBalance: number | null; // running projected balance for that account, if computable
}

export interface ProjectionWarning {
  code: string;
  message: string;
}

export interface FinanceProjection {
  horizon: ProjectionHorizon;
  horizonLabel: string;
  horizonDate: string;
  nextPaydayDate: string | null;
  // Finance 1A.4: truthful next-income wording. `payday` only when an active
  // recurring payday schedule's occurrence is next; `scheduled` for a one-time /
  // non-payroll income; `none` when there is no upcoming income.
  nextIncomeKind: "payday" | "scheduled" | "none";
  nextIncomeDate: string | null;
  accounts: AccountProjection[];
  items: ForecastItem[];
  totals: {
    totalActualCash: number;
    totalProjectedCash: number;
    spendableActualCash: number;
    spendableProjectedCash: number;
    savingsEmergencyActual: number;
    savingsEmergencyProjected: number;
    creditLiabilities: number;
  };
  warnings: ProjectionWarning[];
  unassignedBills: { id: number; name: string; amount: number; dueDate: string | null }[];
  unassignedIncome: { id: number; source: string; amount: number; payDate: string }[];
  linkedSkipped: { kind: string; label: string }[];
}

export interface AllocationView {
  id: number;
  accountId: number;
  accountName: string | null;
  allocationType: string; // fixed | percent | remainder
  value: number | null; // dollars (fixed) | percent (percent) | null (remainder)
  position: number;
}

export interface IncomeView {
  id: number;
  source: string;
  expectedAmount: number;
  payDate: string;
  isPayday: boolean;
  // Finance 1A.2: receipt lifecycle + destination(s).
  status: string; // scheduled | received | cancelled | skipped
  actualAmount: number | null; // confirmed gross at receipt
  receivedAt: string | null;
  destinationAccountId: number | null; // single-destination mode (null = unassigned/split)
  allocations: AllocationView[]; // split mode (empty = single/unassigned)
  // Finance 1A.4: estimate modes + recurring linkage + variance.
  scheduleId: number | null; // recurring occurrence (null = standalone one-time)
  estimateType: string; // fixed | typical | range | unknown
  expectedMin: number | null;
  expectedMax: number | null;
  variance: number | null; // actual − expected (after receipt)
  variancePct: number | null; // variance / expected × 100 (when expected > 0)
}

/** Finance 1A.4: a recurring income schedule (the reusable payday rule). */
export interface IncomeScheduleView {
  id: number;
  source: string;
  cadence: string; // one_time | weekly | biweekly | semimonthly | monthly
  anchorDate: string;
  expectedAmount: number;
  estimateType: string; // fixed | typical | range | unknown
  expectedMin: number | null;
  expectedMax: number | null;
  destinationAccountId: number | null;
  dayOfMonth: number | null;
  dayA: number | null;
  dayB: number | null;
  isPayday: boolean;
  active: boolean;
  endDate: string | null;
  nextDate: string | null; // next upcoming occurrence date (computed)
  allocations: AllocationView[]; // schedule-level split snapshot
}

/** Finance 1A.2: a transfer between two owned accounts. */
export interface TransferView {
  id: number;
  fromAccountId: number;
  fromName: string | null;
  toAccountId: number;
  toName: string | null;
  amount: number;
  scheduledDate: string | null;
  status: string; // scheduled | completed | reversed | cancelled
  completedAt: string | null;
  note: string | null;
}

/* Finance 1B.1 — a NONSECRET view of a read-only bank connection. Deliberately
 * omits every encrypted-token field; nothing here is a secret. */
export interface ConnectionView {
  id: number;
  provider: string; // "plaid"
  institutionId: string | null;
  institutionName: string; // falls back to "Connected institution"
  status: string; // active | login_required | pending_expiration | error | revoked
  environment: string; // "sandbox"
  requiresReauth: boolean;
  connectedAt: string | null; // ISO
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
  // Build 2B.2: the recommendation this plan was created from (null for manual plans).
  selectedRecommendationId: string | null;
}

export interface ExperienceXpSummary {
  total: number;
  completedCount: number;
}

/* --- Home / Today command center (Home 1A, deterministic) ---------------- */

/** One ranked, explainable item in the Home "Needs attention" list. Each carries
 * a human-readable reason. Task items include the TaskView so Home can offer the
 * one direct action (complete); obligation/bill items are read-only. */
export interface HomeNeedItem {
  key: string;
  kind: "task" | "obligation" | "bill";
  title: string;
  reason: string; // e.g. "Overdue 3 days", "Due today", "Critical priority", "Due in 2 days"
  tone: "act" | "aware";
  rank: number; // higher = more urgent; deterministic
  task?: TaskView;
}

export interface HomeComingItem {
  key: string;
  kind: "obligation" | "experience";
  title: string;
  date: string | null;
  detail: string | null;
}

export interface HomeMoney {
  estimatedRemaining: number;
  accountsTotal: number;
  billsDueBeforePayday: number;
  overdueCount: number;
  due7: number;
  due30: number;
  nextPaydayDate: string | null;
  /** Next few unpaid bills (for the one direct action: mark paid). */
  dueBills: BillView[];
  // Finance 1A.3B: truthful actual vs projected for the default horizon.
  manualActualCash: number;
  projectedCash: number;
  projectionHorizonLabel: string;
  hasShortfall: boolean;
  // Finance 1A.4: next expected income (payday vs one-time) + estimate label.
  nextIncomeKind: "payday" | "scheduled" | "none";
  nextIncomeDate: string | null;
  nextIncomeText: string | null; // e.g. "Estimated $900" | "Amount unknown" | "Estimated $800–$1,200"
  hasUnconfirmedIncome: boolean; // an expected occurrence whose date has passed
}

export interface HomeMomentum {
  totalXp: number;
  completedCount: number;
  nextPlanned: { id: number; title: string; plannedDate: string | null } | null;
  lastResolved: { id: number; title: string; status: ExperienceStatus } | null;
  plannedCount: number;
  // Small positive daily signal: tasks completed today (local timezone).
  tasksCompletedToday: number;
}

/** A section is either ok (with data) or unavailable (degraded independently). */
export interface HomeSection<T> {
  ok: boolean;
  data: T | null;
}

export interface HomeView {
  firstName: string | null;
  needsAttention: HomeSection<{ items: HomeNeedItem[]; openTaskCount: number; openObligationCount: number }>;
  comingUp: HomeSection<HomeComingItem[]>;
  money: HomeSection<HomeMoney>;
  momentum: HomeSection<HomeMomentum>;
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
