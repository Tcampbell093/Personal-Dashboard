import {
  pgTable,
  pgEnum,
  serial,
  integer,
  text,
  varchar,
  boolean,
  timestamp,
  date,
  time,
  numeric,
  jsonb,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { ExperienceRecommendation } from "@/lib/types";

/* ===========================================================================
 * Personal Command Center — database schema
 *
 * Conventions used everywhere:
 *   - id            serial primary key
 *   - userId        FK to users.id  (every domain row is owned by a user, so
 *                   multi-user is possible later without a rewrite)
 *   - createdAt     set on insert
 *   - updatedAt     bumped on update (enforced in the service layer)
 *   - deletedAt     soft delete; NULL means "live". Queries filter on this.
 * ======================================================================== */

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
};

/* ---------------------------------------------------------------- enums --- */

export const taskStatus = pgEnum("task_status", [
  "not_started",
  "in_progress",
  "completed",
  "deferred",
  "cancelled",
]);

export const priority = pgEnum("priority", ["low", "medium", "high", "critical"]);

export const recurrence = pgEnum("recurrence", [
  "one_time",
  "daily",
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
  "yearly",
]);

export const obligationType = pgEnum("obligation_type", [
  "appointment",
  "meeting",
  "work_shift",
  "renewal",
  "application_deadline",
  "payment",
  "personal_commitment",
  "event",
  "other_deadline",
]);

export const obligationStatus = pgEnum("obligation_status", [
  "upcoming",
  "in_progress",
  "done",
  "missed",
  "cancelled",
]);

export const importance = pgEnum("importance", ["low", "medium", "high", "critical"]);

export const billStatus = pgEnum("bill_status", [
  "scheduled",
  "due",
  "paid",
  "overdue",
  "skipped",
]);

// Finance 1A.1: provider-neutral source of an account's balance. `manual` =
// owner-entered (the only kind today). `linked` is reserved for a future,
// read-only bank connection (Finance 1B) and is unused for now. Connection
// health (provider id, sync status, errors) deliberately lives in a separate
// `financial_connections` model later — NOT on the account row — because one
// connection may back several accounts.
export const balanceSource = pgEnum("balance_source", ["manual", "linked"]);

// Finance 1A.3A: kinds of recorded account-balance movement. Scoped to the
// manual bill-payment ledger only — a `bill_payment` is a negative movement
// (money left the account); a `bill_payment_reversal` is the equal positive
// movement that undoes it. Income/transfer/reconciliation kinds are deliberately
// NOT added here (Finance 1A.3 proper / 1A.2) — they can be appended later.
export const movementKind = pgEnum("movement_kind", [
  "bill_payment",
  "bill_payment_reversal",
  // Finance 1A.2: income receipt + transfer movements (and their reversals).
  "income_received",
  "income_reversal",
  "transfer_out",
  "transfer_in",
  "transfer_out_reversal",
  "transfer_in_reversal",
]);

// Finance 1A.2: income lifecycle. `scheduled` = expected, no balance change;
// `received` = confirmed, manual destinations credited via the ledger.
export const incomeStatus = pgEnum("income_status", [
  "scheduled",
  "received",
  "cancelled",
]);

// Finance 1A.2: how a split-income row computes its share. `fixed` = a dollar
// amount; `percent` = a percentage OF THE AMOUNT REMAINING AFTER fixed rows;
// `remainder` = whatever is left (absorbs deterministic rounding).
export const allocationType = pgEnum("allocation_type", [
  "fixed",
  "percent",
  "remainder",
]);

// Finance 1A.2: transfer lifecycle between owned accounts. `scheduled` changes
// no balance; `completed` moves manual balances via the ledger; `reversed`
// undoes a completed transfer; `cancelled` drops a scheduled one.
export const transferStatus = pgEnum("transfer_status", [
  "scheduled",
  "completed",
  "reversed",
  "cancelled",
]);

export const signalType = pgEnum("signal_type", [
  "weather",
  "local_event",
  "festival",
  "vendor_opportunity",
  "estate_sale",
  "garage_sale",
  "auction",
  "business_opening",
  "business_closing",
  "liquidation",
  "local_news",
  "job_posting",
  "grant",
  "training_opportunity",
  "marketplace_listing",
  "construction",
  "road_closure",
  "community_need",
  "holiday",
  "convention",
  "entertainment",
  "technology",
  "ai_development",
  "other",
]);

export const signalStatus = pgEnum("signal_status", [
  "new",
  "reviewed",
  "saved",
  "used_in_opportunity",
  "dismissed",
  "expired",
]);

export const opportunityCategory = pgEnum("opportunity_category", [
  "quick_cash",
  "resale_flipping",
  "arbitrage",
  "temporary_demand",
  "event_based",
  "vendor_opportunity",
  "service_opportunity",
  "access_opportunity",
  "career_opportunity",
  "cost_saving_opportunity",
  "creative_combination",
  "long_shot",
  "other",
]);

export const opportunityStatus = pgEnum("opportunity_status", [
  "new",
  "saved",
  "researching",
  "planning",
  "acted_on",
  "successful",
  "unsuccessful",
  "dismissed",
  "expired",
]);

export const feedbackKind = pgEnum("feedback_kind", [
  "save",
  "dismiss",
  "too_obvious",
  "too_expensive",
  "too_risky",
  "not_enough_time",
  "more_like_this",
  "would_actually_do",
  "acted_on",
]);

export const jobStatus = pgEnum("job_status", [
  "new",
  "saved",
  "reviewing",
  "applying",
  "applied",
  "interviewing",
  "rejected",
  "offer",
  "dismissed",
  "expired",
]);

export const interestStatus = pgEnum("interest_status", [
  "new",
  "read",
  "saved",
  "dismissed",
]);

export const runStatus = pgEnum("run_status", ["success", "failure", "skipped"]);

/* Experience and Adventure Loop v1 — Build 1 (manual lifecycle) enums.
 * AI/recommendation enums (e.g. experience_interpretation_source) are deliberately
 * deferred to the build that implements those behaviors. */
export const experienceRequestStatus = pgEnum("experience_request_status", [
  "draft",
  "interpreted",
  "recommendations_ready",
  "planned",
]);

// Build 2A: how the request's current constraints were produced.
// `fallback` is deliberately omitted until an automated fallback actually exists.
export const experienceInterpretationSource = pgEnum("experience_interpretation_source", [
  "manual",
  "ai",
]);

export const experienceStatus = pgEnum("experience_status", [
  "planned",
  "completed",
  "cancelled",
  "not_completed",
]);

export const experienceEnergyLevel = pgEnum("experience_energy_level", [
  "low",
  "medium",
  "high",
]);

export const experiencePhysicalDifficulty = pgEnum("experience_physical_difficulty", [
  "easy",
  "moderate",
  "challenging",
]);

/* ---------------------------------------------------------------- users --- */

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 320 }).notNull().unique(),
  name: varchar("name", { length: 120 }),
  ...timestamps,
});

export const userPreferences = pgTable("user_preferences", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" })
    .unique(),
  homeArea: text("home_area"),
  workArea: text("work_area"),
  searchRadiusMiles: integer("search_radius_miles").default(25),
  transportation: text("transportation"), // e.g. "car", "transit"
  weeklyAvailability: jsonb("weekly_availability"), // free-form availability map
  startupBudget: numeric("startup_budget", { precision: 12, scale: 2 }),
  maxRisk: importance("max_risk").default("medium"),
  skills: jsonb("skills").$type<string[]>().default([]),
  workExperience: text("work_experience"),
  interests: jsonb("interests").$type<string[]>().default([]),
  careerPreferences: text("career_preferences"),
  desiredSalaryMin: numeric("desired_salary_min", { precision: 12, scale: 2 }),
  desiredSalaryMax: numeric("desired_salary_max", { precision: 12, scale: 2 }),
  maxCommuteMinutes: integer("max_commute_minutes"),
  opportunityInterests: jsonb("opportunity_interests").$type<string[]>().default([]),
  excludedOpportunityCategories: jsonb("excluded_opportunity_categories")
    .$type<string[]>()
    .default([]),
  monitoredAreas: jsonb("monitored_areas").$type<string[]>().default([]),
  newsTopics: jsonb("news_topics").$type<string[]>().default([]),
  entertainmentTopics: jsonb("entertainment_topics").$type<string[]>().default([]),
  technologyTopics: jsonb("technology_topics").$type<string[]>().default([]),
  ...timestamps,
});

/* ---------------------------------------------------------------- tasks --- */

export const tasks = pgTable(
  "tasks",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 280 }).notNull(),
    description: text("description"),
    dueDate: date("due_date"),
    dueTime: time("due_time"),
    priority: priority("priority").notNull().default("medium"),
    status: taskStatus("status").notNull().default("not_started"),
    category: varchar("category", { length: 80 }),
    recurrence: recurrence("recurrence").notNull().default("one_time"),
    notes: text("notes"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("tasks_user_status_idx").on(t.userId, t.status),
    index("tasks_due_idx").on(t.dueDate),
  ],
);

/* ---------------------------------------------------------- obligations --- */

export const obligations = pgTable(
  "obligations",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 280 }).notNull(),
    type: obligationType("type").notNull().default("appointment"),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    startTime: time("start_time"),
    location: text("location"),
    description: text("description"),
    importance: importance("importance").notNull().default("medium"),
    reminderDate: date("reminder_date"),
    status: obligationStatus("status").notNull().default("upcoming"),
    source: varchar("source", { length: 120 }).default("manual"),
    // Reserved for future Google Calendar sync — unused in Phase 1.
    externalCalendarId: varchar("external_calendar_id", { length: 255 }),
    ...timestamps,
  },
  (t) => [
    index("obligations_user_start_idx").on(t.userId, t.startDate),
    index("obligations_status_idx").on(t.status),
  ],
);

/* ------------------------------------------------------------- finances --- */

export const financialAccounts = pgTable("financial_accounts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 120 }).notNull(),
  // Account classification. Kept as a server-validated varchar (not a pgEnum) so
  // the owner can grow the vocabulary later without a type migration. Validated
  // against ACCOUNT_TYPES in the service/route layer. checking|savings|cash|credit|other.
  type: varchar("type", { length: 60 }).default("checking"),
  // Finance 1A.1: who the account is with (optional, display only).
  institution: varchar("institution", { length: 120 }),
  // What the account is for. Server-validated varchar (same rationale as `type`):
  // spending|bills|savings|emergency|cash|other. Existing rows default to
  // 'other' (unspecified) — never guessed.
  purpose: varchar("purpose", { length: 40 }).notNull().default("other"),
  // Manually entered actual balance. For credit accounts this is the amount OWED
  // (a liability, positive = you owe) and is NEVER counted as cash. No bank
  // connection in Finance 1A.1 (balanceSource is always 'manual').
  currentBalance: numeric("current_balance", { precision: 14, scale: 2 }).default("0"),
  // Where the balance comes from. 'manual' for every account today; 'linked' is
  // reserved for a future read-only bank connection and is unused now.
  balanceSource: balanceSource("balance_source").notNull().default("manual"),
  // Whether this account's (positive cash) balance contributes to spendable cash.
  // Cash-type accounts count toward total actual cash regardless; this flag only
  // narrows the spendable subset (e.g. exclude savings/emergency).
  includeInSpendable: boolean("include_in_spendable").notNull().default(true),
  // Inactive accounts are retained but excluded from every cash/liability total.
  active: boolean("active").notNull().default(true),
  balanceUpdatedAt: timestamp("balance_updated_at", { withTimezone: true }),
  notes: text("notes"),
  ...timestamps,
});

export const recurringBills = pgTable(
  "recurring_bills",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 160 }).notNull(),
    expectedAmount: numeric("expected_amount", { precision: 12, scale: 2 }).notNull(),
    minimumPayment: numeric("minimum_payment", { precision: 12, scale: 2 }),
    dueDayOfMonth: integer("due_day_of_month"), // 1-31 for monthly bills
    recurrence: recurrence("recurrence").notNull().default("monthly"),
    notes: text("notes"),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (t) => [index("recurring_bills_user_idx").on(t.userId)],
);

// One-time bills AND concrete instances of bills (e.g. "Feb electric bill").
export const financialEntries = pgTable(
  "financial_entries",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // If this entry came from a recurring template, link it.
    recurringBillId: integer("recurring_bill_id").references(() => recurringBills.id),
    // Finance 1A.1: the account this bill is normally paid FROM (nullable — an
    // existing/unassigned bill stays valid and is shown as "Payment account not
    // assigned"; never auto-guessed or back-filled). `paidAccountId` records the
    // account actually used when the bill is marked paid. Neither mutates any
    // account balance in 1A.1 (the recorded-movements ledger arrives in 1A.3).
    sourceAccountId: integer("source_account_id").references(() => financialAccounts.id),
    paidAccountId: integer("paid_account_id").references(() => financialAccounts.id),
    name: varchar("name", { length: 160 }).notNull(),
    kind: varchar("kind", { length: 20 }).notNull().default("bill"), // bill | income
    dueDate: date("due_date"),
    expectedAmount: numeric("expected_amount", { precision: 12, scale: 2 }).notNull(),
    actualAmount: numeric("actual_amount", { precision: 12, scale: 2 }),
    minimumPayment: numeric("minimum_payment", { precision: 12, scale: 2 }),
    status: billStatus("status").notNull().default("scheduled"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [
    index("financial_entries_user_due_idx").on(t.userId, t.dueDate),
    index("financial_entries_status_idx").on(t.status),
  ],
);

export const incomeEntries = pgTable(
  "income_entries",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: varchar("source", { length: 160 }).notNull(),
    expectedAmount: numeric("expected_amount", { precision: 12, scale: 2 }).notNull(),
    actualAmount: numeric("actual_amount", { precision: 12, scale: 2 }),
    payDate: date("pay_date").notNull(),
    recurrence: recurrence("recurrence").notNull().default("biweekly"),
    isPayday: boolean("is_payday").notNull().default(true),
    // Finance 1A.2: single-destination account (null = unassigned, or split mode
    // when income_allocations rows exist). Status drives the receipt lifecycle.
    destinationAccountId: integer("destination_account_id").references(
      () => financialAccounts.id,
    ),
    status: incomeStatus("status").notNull().default("scheduled"),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [index("income_entries_user_date_idx").on(t.userId, t.payDate)],
);

/* Finance 1A.2 — split-income allocation rows. Each row sends part of one income
 * entry to an owned account by a `fixed` dollar amount, a `percent` of the amount
 * remaining after fixed rows, or the `remainder`. Resolution order: fixed →
 * percent-of-remaining → remainder (which absorbs deterministic rounding). At
 * most one remainder row; no duplicate destination account per income. */
export const incomeAllocations = pgTable(
  "income_allocations",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    incomeId: integer("income_id")
      .notNull()
      .references(() => incomeEntries.id, { onDelete: "cascade" }),
    accountId: integer("account_id")
      .notNull()
      .references(() => financialAccounts.id),
    allocationType: allocationType("allocation_type").notNull(),
    // fixed → dollar amount; percent → percentage (e.g. 60.00); remainder → null.
    value: numeric("value", { precision: 14, scale: 2 }),
    position: integer("position").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index("income_allocations_income_idx").on(t.incomeId),
    // One allocation per destination account per income (no duplicate targets).
    uniqueIndex("income_allocations_income_account_uq").on(t.incomeId, t.accountId),
  ],
);

/* Finance 1A.2 — a transfer of money between two OWNED accounts. `scheduled`
 * changes no balance; completing a manual→manual transfer atomically moves both
 * balances and writes paired transfer_out/transfer_in movements. An internal
 * transfer is never income or spending and never changes total owned cash. */
export const accountTransfers = pgTable(
  "account_transfers",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fromAccountId: integer("from_account_id")
      .notNull()
      .references(() => financialAccounts.id),
    toAccountId: integer("to_account_id")
      .notNull()
      .references(() => financialAccounts.id),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    scheduledDate: date("scheduled_date"),
    status: transferStatus("status").notNull().default("scheduled"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    note: text("note"),
    ...timestamps,
  },
  (t) => [index("account_transfers_user_idx").on(t.userId, t.status)],
);

/* Finance 1A.3A — manual bill-payment ledger.
 * Append-only record of every change a recorded bill payment makes to a MANUAL
 * account balance. A `bill_payment` is negative (money left the account); its
 * `bill_payment_reversal` is the equal positive entry. Rows are NEVER updated or
 * deleted (no updatedAt/deletedAt) — corrections are made by appending a
 * reversal. `reversalOfId` points a reversal at the payment it undoes; a partial
 * unique index on it makes a second reversal of the same payment impossible
 * (no double credit). External/cash payments and payments against `linked`
 * accounts create NO movement (no manual balance is changed). */
export const accountMovements = pgTable(
  "account_movements",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // The manual account whose balance this movement changed.
    accountId: integer("account_id")
      .notNull()
      .references(() => financialAccounts.id),
    // What this movement relates to — exactly one of these is set per row,
    // matching `kind`: bill payment, income receipt, or transfer.
    billId: integer("bill_id").references(() => financialEntries.id),
    incomeId: integer("income_id").references(() => incomeEntries.id),
    transferId: integer("transfer_id").references(() => accountTransfers.id),
    kind: movementKind("kind").notNull(),
    // Signed: negative for a payment, positive for a reversal.
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    // Set on a reversal row → the payment movement it reverses (self-reference).
    reversalOfId: integer("reversal_of_id").references(
      (): AnyPgColumn => accountMovements.id,
    ),
    note: text("note"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("account_movements_user_idx").on(t.userId, t.occurredAt),
    index("account_movements_bill_idx").on(t.billId),
    // At most one reversal per payment movement — blocks a double credit.
    uniqueIndex("account_movements_reversal_uq")
      .on(t.reversalOfId)
      .where(sqlNotNull(t.reversalOfId)),
  ],
);

/* -------------------------------------------------------------- signals --- */

export const signalSources = pgTable("signal_sources", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 160 }).notNull(),
  baseUrl: text("base_url"),
  kind: varchar("kind", { length: 60 }), // rss | api | manual | scrape
  active: boolean("active").notNull().default(true),
  ...timestamps,
});

export const signals = pgTable(
  "signals",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceId: integer("source_id").references(() => signalSources.id),
    title: varchar("title", { length: 280 }).notNull(),
    summary: text("summary"),
    type: signalType("type").notNull().default("other"),
    sourceName: varchar("source_name", { length: 160 }),
    sourceUrl: text("source_url"),
    // Dedup fields — populated by the ingest layer later.
    normalizedUrl: text("normalized_url"),
    externalId: varchar("external_id", { length: 255 }),
    contentHash: varchar("content_hash", { length: 64 }),
    duplicateOf: integer("duplicate_of"),
    isDuplicate: boolean("is_duplicate").notNull().default(false),
    location: text("location"),
    eventDate: date("event_date"),
    startDate: date("start_date"),
    endDate: date("end_date"),
    expirationDate: date("expiration_date"),
    discoveredAt: timestamp("discovered_at", { withTimezone: true }).defaultNow(),
    cost: numeric("cost", { precision: 12, scale: 2 }),
    estimatedAttendance: integer("estimated_attendance"),
    rawNotes: text("raw_notes"),
    confirmedFacts: text("confirmed_facts"),
    tags: jsonb("tags").$type<string[]>().default([]),
    relevanceScore: integer("relevance_score"), // 0-100
    urgencyScore: integer("urgency_score"), // 0-100
    confidenceScore: integer("confidence_score"), // 0-100
    status: signalStatus("status").notNull().default("new"),
    isMock: boolean("is_mock").notNull().default(false), // labels seeded demo data
    ...timestamps,
  },
  (t) => [
    index("signals_user_status_idx").on(t.userId, t.status),
    index("signals_type_idx").on(t.type),
    // Same normalized URL twice for one user = likely a duplicate.
    uniqueIndex("signals_user_normurl_uq")
      .on(t.userId, t.normalizedUrl)
      .where(sqlNotNull(t.normalizedUrl)),
    uniqueIndex("signals_user_hash_uq")
      .on(t.userId, t.contentHash)
      .where(sqlNotNull(t.contentHash)),
  ],
);

/* --------------------------------------------------------- opportunities -- */

export const opportunities = pgTable(
  "opportunities",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 280 }).notNull(),
    summary: text("summary"),
    category: opportunityCategory("category").notNull().default("other"),
    whatIsHappening: text("what_is_happening"),
    creativeAngle: text("creative_angle"),
    whyItFits: text("why_it_fits"),
    timeWindowStart: date("time_window_start"),
    timeWindowEnd: date("time_window_end"),
    startupCost: numeric("startup_cost", { precision: 12, scale: 2 }),
    estimatedEffort: importance("estimated_effort"),
    estimatedRisk: importance("estimated_risk"),
    confidenceScore: integer("confidence_score"), // 0-100
    potentialValue: numeric("potential_value", { precision: 12, scale: 2 }),
    openQuestions: jsonb("open_questions").$type<string[]>().default([]),
    possibleObstacles: jsonb("possible_obstacles").$type<string[]>().default([]),
    nextActions: jsonb("next_actions").$type<string[]>().default([]),
    sourceLinks: jsonb("source_links").$type<string[]>().default([]),
    status: opportunityStatus("status").notNull().default("new"),
    expirationDate: date("expiration_date"),
    // "manual" in Phase 1; "ai" once generation is enabled.
    generatedBy: varchar("generated_by", { length: 20 }).notNull().default("manual"),
    ...timestamps,
  },
  (t) => [index("opportunities_user_status_idx").on(t.userId, t.status)],
);

// many-to-many: which signals back which opportunity
export const opportunitySignals = pgTable(
  "opportunity_signals",
  {
    id: serial("id").primaryKey(),
    opportunityId: integer("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    signalId: integer("signal_id")
      .notNull()
      .references(() => signals.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("opp_signal_uq").on(t.opportunityId, t.signalId)],
);

// append-only feedback log — trains future recommendations
export const opportunityFeedback = pgTable("opportunity_feedback", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  opportunityId: integer("opportunity_id")
    .notNull()
    .references(() => opportunities.id, { onDelete: "cascade" }),
  kind: feedbackKind("kind").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/* ------------------------------------------------------- daily briefings -- */

export const dailyBriefings = pgTable(
  "daily_briefings",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    briefingDate: date("briefing_date").notNull(),
    summary: text("summary"),
    mostImportantTask: text("most_important_task"),
    mostImportantObligation: text("most_important_obligation"),
    mostRelevantOpportunity: text("most_relevant_opportunity"),
    warning: text("warning"),
    // "rule_based" in Phase 1; "ai" later.
    generatedBy: varchar("generated_by", { length: 20 }).notNull().default("rule_based"),
    ...timestamps,
  },
  (t) => [uniqueIndex("briefing_user_date_uq").on(t.userId, t.briefingDate)],
);

/* ----------------------------------------------------------------- jobs --- */

export const jobs = pgTable(
  "jobs",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 280 }).notNull(),
    company: varchar("company", { length: 200 }),
    location: text("location"),
    salaryMin: numeric("salary_min", { precision: 12, scale: 2 }),
    salaryMax: numeric("salary_max", { precision: 12, scale: 2 }),
    employmentType: varchar("employment_type", { length: 60 }), // full_time, contract...
    workArrangement: varchar("work_arrangement", { length: 60 }), // remote, hybrid, onsite
    description: text("description"),
    requirements: text("requirements"),
    source: varchar("source", { length: 120 }),
    sourceUrl: text("source_url"),
    postedDate: date("posted_date"),
    applicationDeadline: date("application_deadline"),
    matchScore: integer("match_score"), // 0-100
    whyItMatches: text("why_it_matches"),
    possibleConcerns: text("possible_concerns"),
    status: jobStatus("status").notNull().default("new"),
    isMock: boolean("is_mock").notNull().default(false),
    ...timestamps,
  },
  (t) => [index("jobs_user_status_idx").on(t.userId, t.status)],
);

/* ------------------------------------------------------ interest watch --- */

export const interestTopics = pgTable("interest_topics", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 120 }).notNull(),
  active: boolean("active").notNull().default(true),
  ...timestamps,
});

export const interestItems = pgTable(
  "interest_items",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    topicId: integer("topic_id").references(() => interestTopics.id, {
      onDelete: "set null",
    }),
    title: varchar("title", { length: 280 }).notNull(),
    summary: text("summary"),
    source: varchar("source", { length: 160 }),
    sourceUrl: text("source_url"),
    publishedDate: date("published_date"),
    whyItMatters: text("why_it_matters"),
    relevanceScore: integer("relevance_score"), // 0-100
    status: interestStatus("status").notNull().default("new"),
    isMock: boolean("is_mock").notNull().default(false),
    ...timestamps,
  },
  (t) => [index("interest_items_user_idx").on(t.userId, t.topicId)],
);

/* ----------------------------------- intelligence: cost + run controls --- */

// One row per user holding the kill switch and budget caps.
export const intelligenceSettings = pgTable("intelligence_settings", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" })
    .unique(),
  aiAutomationEnabled: boolean("ai_automation_enabled").notNull().default(false),
  killSwitch: boolean("kill_switch").notNull().default(false), // true = halt everything
  dailyApiCallLimit: integer("daily_api_call_limit").default(50),
  monthlyApiCallLimit: integer("monthly_api_call_limit").default(500),
  dailyWebSearchLimit: integer("daily_web_search_limit").default(25),
  monthlyCostLimit: numeric("monthly_cost_limit", { precision: 10, scale: 2 }).default(
    "10.00",
  ),
  lastSuccessfulRun: timestamp("last_successful_run", { withTimezone: true }),
  ...timestamps,
});

export const apiUsageLogs = pgTable(
  "api_usage_logs",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 60 }).notNull(), // anthropic, openai, weather...
    operation: varchar("operation", { length: 120 }),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    estimatedCost: numeric("estimated_cost", { precision: 10, scale: 4 }),
    success: boolean("success").notNull().default(true),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("api_usage_provider_idx").on(t.provider, t.createdAt)],
);

export const scheduledRunLogs = pgTable(
  "scheduled_run_logs",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
    jobName: varchar("job_name", { length: 120 }).notNull(),
    status: runStatus("status").notNull(),
    detail: text("detail"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("run_logs_job_idx").on(t.jobName, t.startedAt)],
);

/* ----------------------------------------- experience & adventure loop --- */
/* Build 1: manual lifecycle only. Two durable entities. AI/recommendation
 * columns (provider/model provenance, recommendations JSON,
 * selectedRecommendationId) are intentionally deferred to later builds. */

export const experienceRequests = pgTable(
  "experience_requests",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestText: text("request_text").notNull(),
    availableDate: date("available_date"),
    availableTimeText: varchar("available_time_text", { length: 120 }),
    budgetMax: numeric("budget_max", { precision: 12, scale: 2 }),
    // Prefilled from user_preferences.homeArea, but request-specific and editable.
    startingLocation: text("starting_location"),
    maxTravelMiles: integer("max_travel_miles"),
    maxTravelMinutes: integer("max_travel_minutes"),
    energyLevel: experienceEnergyLevel("energy_level"),
    desiredFeeling: text("desired_feeling"),
    maxPhysicalDifficulty: experiencePhysicalDifficulty("max_physical_difficulty"),
    interests: jsonb("interests").$type<string[]>().default([]),
    exclusions: jsonb("exclusions").$type<string[]>().default([]),
    status: experienceRequestStatus("status").notNull().default("draft"),
    // Build 2A: provenance of the current constraints. `ai` only after a
    // successful AI interpretation; reset to `manual` (provider/model null) when
    // the owner edits any interpreted constraint. Provider/model are bounded
    // text for audit only — never prompts, secrets, or raw responses.
    interpretationSource: experienceInterpretationSource("interpretation_source")
      .notNull()
      .default("manual"),
    interpretationProvider: varchar("interpretation_provider", { length: 60 }),
    interpretationModel: varchar("interpretation_model", { length: 120 }),
    // Build 2B.1: validated recommendation batch (app-owned contract; never raw
    // model output) + provenance. Replaced wholesale on regeneration; cleared
    // when request text or any interpreted constraint changes.
    recommendations: jsonb("recommendations")
      .$type<ExperienceRecommendation[]>()
      .notNull()
      .default([]),
    recommendationSource: experienceInterpretationSource("recommendation_source"),
    recommendationProvider: varchar("recommendation_provider", { length: 60 }),
    recommendationModel: varchar("recommendation_model", { length: 120 }),
    ...timestamps,
  },
  (t) => [index("experience_requests_user_status_idx").on(t.userId, t.status)],
);

export const experiences = pgTable(
  "experiences",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestId: integer("request_id")
      .notNull()
      .references(() => experienceRequests.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 280 }).notNull(),
    description: text("description"),
    plannedDate: date("planned_date"),
    plannedTimeText: varchar("planned_time_text", { length: 120 }),
    locationText: text("location_text"),
    expectedCost: numeric("expected_cost", { precision: 12, scale: 2 }),
    actualCost: numeric("actual_cost", { precision: 12, scale: 2 }),
    expectedDurationMinutes: integer("expected_duration_minutes"),
    physicalDifficulty: experiencePhysicalDifficulty("physical_difficulty"),
    desiredFeeling: text("desired_feeling"),
    notes: text("notes"),
    status: experienceStatus("status").notNull().default("planned"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    nonCompletionReason: text("non_completion_reason"),
    rating: integer("rating"),
    reflection: text("reflection"),
    meaningfulExperience: boolean("meaningful_experience").notNull().default(false),
    adventureXp: integer("adventure_xp").notNull().default(0),
    // Build 2B.2: the app-assigned recommendation id this plan was created from
    // (null for manual plans). Opaque text, for traceability + deletion recovery.
    selectedRecommendationId: varchar("selected_recommendation_id", { length: 64 }),
    ...timestamps,
  },
  (t) => [
    index("experiences_user_status_idx").on(t.userId, t.status),
    // At most one live experience per request — DB-level duplicate-plan guard.
    uniqueIndex("experiences_request_live_uq")
      .on(t.requestId)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/* --------------------------------------------------------------- helper --- */
// drizzle-orm sql helper for partial-index predicates
import { sql } from "drizzle-orm";
function sqlNotNull(col: unknown) {
  return sql`${col} IS NOT NULL`;
}
