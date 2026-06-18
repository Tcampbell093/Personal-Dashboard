/* =============================================================================
 * MOCK DATA — Phase 1 only.
 *
 * Everything here is fabricated demonstration content so the dashboard renders
 * before a database is connected. Each item flows through the UI with a "MOCK"
 * label. Replace by wiring lib/services/* to real Neon queries.
 * ========================================================================== */

import type {
  TaskView,
  ObligationView,
  FinancialOutlook,
  SignalView,
  OpportunityView,
  JobView,
  InterestItemView,
} from "./types";

// Anchor the mock data to "today" so dates always look current in the demo.
const today = new Date();
const iso = (offsetDays: number) => {
  const d = new Date(today);
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

export const mockTasks: TaskView[] = [
  {
    id: 1,
    title: "Submit vendor application for the Somerville street fair",
    dueDate: iso(0),
    dueTime: "17:00",
    priority: "critical",
    status: "not_started",
    category: "Opportunity",
  },
  {
    id: 2,
    title: "Renew vehicle registration",
    dueDate: iso(2),
    dueTime: null,
    priority: "high",
    status: "in_progress",
    category: "Admin",
  },
  {
    id: 3,
    title: "Draft Phase 2 plan for Command Center",
    dueDate: iso(4),
    dueTime: null,
    priority: "medium",
    status: "not_started",
    category: "Projects",
  },
  {
    id: 4,
    title: "Call dentist to reschedule",
    dueDate: iso(1),
    dueTime: "09:30",
    priority: "low",
    status: "not_started",
    category: "Personal",
  },
];

export const mockObligations: ObligationView[] = [
  {
    id: 1,
    title: "Warehouse leadership sync",
    type: "meeting",
    startDate: iso(0),
    startTime: "14:00",
    location: "Conference Room B",
    importance: "high",
  },
  {
    id: 2,
    title: "Car insurance renewal deadline",
    type: "renewal",
    startDate: iso(3),
    startTime: null,
    location: null,
    importance: "high",
  },
  {
    id: 3,
    title: "Dentist appointment",
    type: "appointment",
    startDate: iso(6),
    startTime: "10:00",
    location: "Bridgewater Dental",
    importance: "medium",
  },
];

export const mockFinances: FinancialOutlook = {
  accountsTotal: 4280.55,
  nextPaydayDate: iso(5),
  expectedIncomeBeforePayday: 0,
  billsDueBeforePayday: 612.0,
  estimatedRemaining: 3668.55,
  overdueCount: 1,
  due7: 612.0,
  due14: 1240.0,
  due30: 2105.0,
};

export const mockSignals: SignalView[] = [
  {
    id: 1,
    title: "Heat advisory: 97°F forecast for Saturday",
    type: "weather",
    location: "Somerville, NJ",
    eventDate: iso(2),
    expirationDate: iso(2),
    urgencyScore: 70,
    relevanceScore: 60,
    status: "new",
    isMock: true,
  },
  {
    id: 2,
    title: "Downtown Somerville Street Festival — vendor slots open",
    type: "festival",
    location: "Main St, Somerville",
    eventDate: iso(2),
    expirationDate: iso(0),
    urgencyScore: 85,
    relevanceScore: 80,
    status: "new",
    isMock: true,
  },
  {
    id: 3,
    title: "Estate sale Friday — full garage + tools listed",
    type: "estate_sale",
    location: "Bridgewater, NJ",
    eventDate: iso(1),
    expirationDate: iso(1),
    urgencyScore: 55,
    relevanceScore: 65,
    status: "new",
    isMock: true,
  },
  {
    id: 4,
    title: "Office furniture liquidation — local firm downsizing",
    type: "liquidation",
    location: "Raritan, NJ",
    eventDate: iso(7),
    expirationDate: iso(9),
    urgencyScore: 40,
    relevanceScore: 50,
    status: "reviewed",
    isMock: true,
  },
];

export const mockOpportunities: OpportunityView[] = [
  {
    id: 1,
    title: "Cold drinks + shade stand at Saturday's hot-weather festival",
    summary:
      "97°F forecast + open vendor slots at the street festival = high-traffic demand for cold beverages and shade. Low startup cost, tight time window.",
    category: "event_based",
    timeWindowEnd: iso(0),
    confidenceScore: 65,
    potentialValue: 800,
    estimatedRisk: "low",
    status: "new",
  },
];

export const mockJobs: JobView[] = [
  {
    id: 1,
    title: "Warehouse Operations Systems Lead",
    company: "Regional 3PL",
    location: "Edison, NJ",
    matchScore: 88,
    workArrangement: "hybrid",
    status: "new",
    isMock: true,
  },
  {
    id: 2,
    title: "Internal Tools Developer (No/Low-Code)",
    company: "Logistics SaaS",
    location: "Remote",
    matchScore: 81,
    workArrangement: "remote",
    status: "new",
    isMock: true,
  },
];

export const mockInterest: InterestItemView[] = [
  {
    id: 1,
    topic: "Artificial Intelligence",
    title: "New agentic coding workflows for solo builders",
    source: "Tech blog",
    relevanceScore: 75,
    isMock: true,
  },
  {
    id: 2,
    topic: "Warehouse Technology",
    title: "Cheaper handheld scanners hitting the secondary market",
    source: "Industry newsletter",
    relevanceScore: 60,
    isMock: true,
  },
];
