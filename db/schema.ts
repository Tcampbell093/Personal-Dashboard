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
 * Xanther — database schema
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
  // Finance 1A.3B: manual-account reconciliation (set actual to the real bank
  // balance) and its undo. The signed `amount` is the adjustment delta;
  // `prior_balance`/`new_balance` record the audit trail.
  "reconcile_adjustment",
  "reconcile_reversal",
]);

// Finance 1A.2: income lifecycle. `scheduled` = expected, no balance change;
// `received` = confirmed, manual destinations credited via the ledger.
// Finance 1A.4 adds `skipped` (a recurring occurrence the owner skipped — no
// balance change, excluded from projection).
export const incomeStatus = pgEnum("income_status", [
  "scheduled",
  "received",
  "cancelled",
  "skipped",
  // Finance 1B.4B: occurrence confirmed by LINKED bank evidence (an imported
  // transaction proves the deposit). Distinct from `received`, which implies a
  // manual account_movement; `received_evidence` writes NO movement (the deposit
  // already lives in the provider-authoritative linked balance).
  "received_evidence",
]);

// Finance 1A.4: recurring-income cadence (a payday schedule, distinct from the
// shared `recurrence` enum which tasks/bills also use).
export const incomeCadence = pgEnum("income_cadence", [
  "one_time",
  "weekly",
  "biweekly",
  "semimonthly",
  "monthly",
]);

// Finance 1A.4: how an estimated paycheck amount is known. An estimate stays an
// estimate until the occurrence is received. `unknown` forecasts only the payday
// (contributes $0 to projected cash).
export const estimateType = pgEnum("estimate_type", [
  "fixed",
  "typical",
  "range",
  "unknown",
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

// Finance 1B.1: health of a read-only bank connection (provider-neutral; mirrors
// the `ConnectionStatus` DTO in lib/providers/types.ts). `active` = usable;
// `login_required`/`pending_expiration` = repair needed; `error`/`revoked` =
// unusable. Soft-disconnect/archive is tracked by `disconnectedAt` + `deletedAt`.
export const connectionStatus = pgEnum("connection_status", [
  "active",
  "login_required",
  "pending_expiration",
  "error",
  "revoked",
]);

// Finance 1B.2: lifecycle of a discovered provider account. `active` = seen on
// the latest sync; `stale` = previously seen but absent from the latest sync
// (retained for audit/repair, never deleted).
export const providerAccountStatus = pgEnum("provider_account_status", ["active", "stale"]);

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
  // Finance 1A.3B: when the owner last reconciled this manual balance to the real
  // bank balance (null = never verified). Derivable from the reconcile ledger;
  // stored for display + the "last verified" answer.
  lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }),
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
    // Finance 1A.4: a materialized occurrence of a recurring schedule (null = a
    // standalone one-time income). `estimateType`/`expectedMin`/`expectedMax` are
    // copied from the schedule at generation so each occurrence is self-contained
    // for projection. Standalone income defaults to a `fixed` estimate.
    scheduleId: integer("schedule_id").references((): AnyPgColumn => incomeSchedules.id),
    estimateType: estimateType("estimate_type").notNull().default("fixed"),
    expectedMin: numeric("expected_min", { precision: 12, scale: 2 }),
    expectedMax: numeric("expected_max", { precision: 12, scale: 2 }),
    // Finance 1A.4 correction: the schedule rule-date this occurrence fills (set
    // at generation; survives an individual date override) — schedule regeneration
    // skips a rule date already claimed by an existing occurrence's scheduled_for.
    scheduledFor: date("scheduled_for"),
    // True once the owner edits this individual occurrence (amount/date/estimate/
    // destination/split). Overridden occurrences are NEVER regenerated/overwritten
    // by a schedule edit. Tracked explicitly (never inferred from value diffs).
    isOverridden: boolean("is_overridden").notNull().default(false),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [
    index("income_entries_user_date_idx").on(t.userId, t.payDate),
    // One live occurrence per schedule per date — idempotent generation backstop.
    uniqueIndex("income_entries_schedule_date_uq")
      .on(t.scheduleId, t.payDate)
      .where(sql`${t.scheduleId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
  ],
);

/* Finance 1A.4 — a recurring income SCHEDULE (the reusable rule). Occurrences are
 * materialized as `income_entries` rows (linked by `scheduleId`), so they reuse
 * the whole receipt/reversal/split/projection machinery. Editing a schedule
 * regenerates only its FUTURE scheduled occurrences; received/skipped/cancelled/
 * past occurrences are preserved. */
export const incomeSchedules = pgTable(
  "income_schedules",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: varchar("source", { length: 160 }).notNull(),
    cadence: incomeCadence("cadence").notNull(),
    anchorDate: date("anchor_date").notNull(),
    // expected amount estimate (0 allowed for `unknown`); optional range bounds.
    expectedAmount: numeric("expected_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    estimateType: estimateType("estimate_type").notNull().default("fixed"),
    expectedMin: numeric("expected_min", { precision: 12, scale: 2 }),
    expectedMax: numeric("expected_max", { precision: 12, scale: 2 }),
    destinationAccountId: integer("destination_account_id").references(
      () => financialAccounts.id,
    ),
    // monthly: dayOfMonth (a day > the month's last day resolves to the last day);
    // semimonthly: dayA + dayB (same last-day resolution).
    dayOfMonth: integer("day_of_month"),
    dayA: integer("day_a"),
    dayB: integer("day_b"),
    isPayday: boolean("is_payday").notNull().default(true),
    active: boolean("active").notNull().default(true),
    endDate: date("end_date"),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [index("income_schedules_user_idx").on(t.userId, t.active)],
);

// Finance 1A.4: split-allocation rows on a SCHEDULE (snapshot source). When an
// occurrence is generated, these are copied into income_allocations for it.
export const incomeScheduleAllocations = pgTable(
  "income_schedule_allocations",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scheduleId: integer("schedule_id")
      .notNull()
      .references(() => incomeSchedules.id, { onDelete: "cascade" }),
    accountId: integer("account_id")
      .notNull()
      .references(() => financialAccounts.id),
    allocationType: allocationType("allocation_type").notNull(),
    value: numeric("value", { precision: 14, scale: 2 }),
    position: integer("position").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index("income_schedule_allocations_idx").on(t.scheduleId),
    uniqueIndex("income_schedule_allocations_uq").on(t.scheduleId, t.accountId),
  ],
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
    // Finance 1A.3B: reconciliation audit trail (set only on reconcile_* rows) —
    // the manual actual balance before and after the adjustment. Lets a
    // reconciliation be reversed by restoring `prior_balance`.
    priorBalance: numeric("prior_balance", { precision: 14, scale: 2 }),
    newBalance: numeric("new_balance", { precision: 14, scale: 2 }),
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

/* Finance 1B.1 — read-only bank connection (Plaid Sandbox).
 * One authenticated connection to an institution. A connection may later back
 * several accounts, but 1B.1 stores ONLY the connection + bounded institution
 * metadata — no accounts, balances, transactions, cursor, or mappings yet.
 *
 * The provider access token is NEVER stored in plaintext: only the AES-256-GCM
 * encrypted envelope (cipher + nonce + tag + key/envelope version) from
 * lib/providers/token-crypto.ts is persisted. Error fields are bounded + redacted
 * and never contain a token. `providerItemId` is unique within owner+provider
 * scope so a repeated exchange of the same Item can never create a second row. */
export const financialConnections = pgTable(
  "financial_connections",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 40 }).notNull().default("plaid"),
    // Non-secret provider connection id (Plaid item_id). Stored in clear.
    providerItemId: varchar("provider_item_id", { length: 255 }).notNull(),
    institutionId: varchar("institution_id", { length: 120 }),
    institutionName: varchar("institution_name", { length: 200 }),
    // Encrypted access-token envelope (NO plaintext token column exists).
    accessTokenCipher: text("access_token_cipher").notNull(),
    accessTokenNonce: text("access_token_nonce").notNull(),
    accessTokenTag: text("access_token_tag").notNull(),
    accessTokenKeyVersion: integer("access_token_key_version").notNull(),
    accessTokenEnvelopeVersion: integer("access_token_envelope_version").notNull(),
    status: connectionStatus("status").notNull().default("active"),
    // Sandbox label so the UI can be truthful about fake test data.
    environment: varchar("environment", { length: 20 }).notNull().default("sandbox"),
    consentGrantedAt: timestamp("consent_granted_at", { withTimezone: true }),
    lastSyncAttemptedAt: timestamp("last_sync_attempted_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    requiresReauth: boolean("requires_reauth").notNull().default(false),
    // Bounded, redacted — never a token.
    errorCode: varchar("error_code", { length: 80 }),
    errorMessage: varchar("error_message", { length: 300 }),
    // Optional explicit disconnect/archive timestamp (soft); `deletedAt` from the
    // shared timestamps helper also soft-archives.
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    // Finance 1B.3A — incremental transaction-sync state. The committed Plaid
    // `/transactions/sync` cursor (null = never synced) advances ONLY after every
    // page of a sync has been persisted. `transactionSyncLockedAt` is a DB-level
    // per-connection lock (claimed optimistically, released in a finally) so two
    // concurrent syncs can't corrupt the cursor. Error fields are bounded/redacted.
    transactionsCursor: text("transactions_cursor"),
    lastTransactionSyncAttemptedAt: timestamp("last_transaction_sync_attempted_at", { withTimezone: true }),
    lastTransactionSyncedAt: timestamp("last_transaction_synced_at", { withTimezone: true }),
    transactionSyncLockedAt: timestamp("transaction_sync_locked_at", { withTimezone: true }),
    transactionSyncErrorCode: varchar("transaction_sync_error_code", { length: 80 }),
    transactionSyncErrorMessage: varchar("transaction_sync_error_message", { length: 300 }),
    ...timestamps,
  },
  (t) => [
    index("financial_connections_user_idx").on(t.userId, t.status),
    // Provider Item is unique within owner + provider scope: a repeated exchange
    // of the same Item can never create a second active connection.
    uniqueIndex("financial_connections_owner_item_uq").on(t.userId, t.provider, t.providerItemId),
  ],
);

/* Finance 1B.2 — a provider account discovered from a financial connection
 * (Plaid Sandbox). One row per provider account; cached balances + freshness are
 * stored here (the provider snapshot is authoritative for a linked account — it
 * is NOT copied into an editable financial_accounts.currentBalance). A row may be
 * linked to at most one Xanther `financial_accounts` row (`financialAccountId`),
 * and a Xanther account maps to at most one provider account (partial unique
 * index). No access token, no transaction cursor, no imported transactions, and
 * no raw Plaid payload are stored here. */
export const providerAccounts = pgTable(
  "provider_accounts",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Finance 1B.2 correction: NO ACTION (not cascade) so a connection cannot be
    // hard-deleted while ANY provider account still references it — the DB itself
    // resists orphaning a linked Xanther account. Bounded cleanup deletes the
    // (unmapped) provider-account rows first, then the connection (see
    // deleteConnection); a mapped connection delete is rejected.
    connectionId: integer("connection_id")
      .notNull()
      .references(() => financialConnections.id, { onDelete: "no action" }),
    provider: varchar("provider", { length: 40 }).notNull().default("plaid"),
    // Non-secret provider account id (Plaid account_id). Trusted only WITHIN its connection.
    providerAccountId: varchar("provider_account_id", { length: 255 }).notNull(),
    // The Xanther linked account created from this provider account (null = unmapped).
    financialAccountId: integer("financial_account_id").references(() => financialAccounts.id),
    providerName: varchar("provider_name", { length: 200 }).notNull(),
    officialName: varchar("official_name", { length: 200 }),
    mask: varchar("mask", { length: 16 }), // last 4 only — never a full account number
    // Normalized Xanther type (checking|savings|cash|credit|other); the raw Plaid
    // subtype string is kept for display only.
    providerType: varchar("provider_type", { length: 40 }).notNull().default("other"),
    providerSubtype: varchar("provider_subtype", { length: 60 }),
    currencyCode: varchar("currency_code", { length: 8 }),
    // Cached balance snapshot (nullable when the provider does not supply it).
    balanceCurrent: numeric("balance_current", { precision: 14, scale: 2 }),
    balanceAvailable: numeric("balance_available", { precision: 14, scale: 2 }),
    balanceLimit: numeric("balance_limit", { precision: 14, scale: 2 }),
    // Freshness of the cached snapshot (the time Xanther last synced it).
    balanceAsOf: timestamp("balance_as_of", { withTimezone: true }),
    status: providerAccountStatus("status").notNull().default("active"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    ...timestamps,
  },
  (t) => [
    index("provider_accounts_user_idx").on(t.userId, t.connectionId),
    // Provider account identity is scoped to its connection (idempotent sync).
    uniqueIndex("provider_accounts_conn_acct_uq").on(t.connectionId, t.providerAccountId),
    // A Xanther account maps to at most one provider account.
    uniqueIndex("provider_accounts_financial_acct_uq")
      .on(t.financialAccountId)
      .where(sqlNotNull(t.financialAccountId)),
  ],
);

// Finance 1B.3A: imported-transaction lifecycle. `active` = currently reported by
// the provider; `removed` = the provider reported it removed (kept as a tombstone,
// never hard-deleted).
export const importedTransactionStatus = pgEnum("imported_transaction_status", ["active", "removed"]);

/* Finance 1B.3A — a transaction imported from a bank provider (Plaid Sandbox).
 * This is BANK EVIDENCE, NOT a Xanther command: an imported transaction never
 * creates an `account_movements` row, never mutates a provider/manual balance, and
 * never confirms a bill/income/transfer. It has its own storage + read model.
 * Amounts are stored in Xanther's convention (inflow +, outflow −). Identity is
 * scoped to the connection: a provider transaction id is unique only within its
 * connection. Removed transactions are tombstoned (status='removed' + removedAt),
 * never deleted. Only bounded normalized fields are stored — never the raw payload. */
export const importedTransactions = pgTable(
  "imported_transactions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Connection-scoped evidence: cascades when its (deletable, unmapped) connection
    // is removed. A connection with a LINKED account can't be deleted (1B.2), so a
    // mapped connection's transactions are never cascade-removed.
    connectionId: integer("connection_id")
      .notNull()
      .references(() => financialConnections.id, { onDelete: "cascade" }),
    // Plaid account_id (connection-scoped, non-secret).
    providerAccountId: varchar("provider_account_id", { length: 255 }).notNull(),
    // The mapped Xanther account, if the provider account was added (SET NULL on
    // that account's deletion — the evidence survives as "not added to Xanther").
    financialAccountId: integer("financial_account_id").references(() => financialAccounts.id, { onDelete: "set null" }),
    provider: varchar("provider", { length: 40 }).notNull().default("plaid"),
    // Plaid transaction_id — unique only WITHIN the connection.
    providerTransactionId: varchar("provider_transaction_id", { length: 255 }).notNull(),
    // The pending transaction a POSTED transaction replaced (Plaid only; never guessed).
    pendingProviderTransactionId: varchar("pending_provider_transaction_id", { length: 255 }),
    status: importedTransactionStatus("status").notNull().default("active"),
    isPending: boolean("is_pending").notNull().default(false),
    // Xanther-signed amount: inflow > 0, outflow < 0 (never 0 — $0 are skipped).
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    currencyCode: varchar("currency_code", { length: 8 }),
    descriptionOriginal: varchar("description_original", { length: 500 }),
    descriptionCurrent: varchar("description_current", { length: 500 }).notNull(),
    merchantName: varchar("merchant_name", { length: 200 }),
    authorizedDate: date("authorized_date"),
    postedDate: date("posted_date"),
    // Bounded provider category (display/later-matching hint only; never the raw payload).
    categoryPrimary: varchar("category_primary", { length: 120 }),
    categoryDetailed: varchar("category_detailed", { length: 160 }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true }).defaultNow().notNull(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("imported_transactions_user_idx").on(t.userId),
    index("imported_transactions_account_idx").on(t.financialAccountId),
    index("imported_transactions_conn_status_idx").on(t.connectionId, t.status),
    // Connection-scoped provider transaction identity → idempotent upsert.
    uniqueIndex("imported_transactions_conn_txn_uq").on(t.connectionId, t.providerTransactionId),
  ],
);

// Finance 1B.3B: durable webhook-event lifecycle. `received` → `processing` →
// `processed`; `failed` (retryable, bounded); `ignored` (validly signed but an
// unsupported type/code — no sync).
export const webhookEventStatus = pgEnum("webhook_event_status", ["received", "processing", "processed", "failed", "ignored"]);

/* Finance 1B.3B — a verified Plaid webhook delivery. Stores ONLY bounded,
 * non-secret metadata (NO access token, encryption fields, raw payload, account
 * numbers, or transaction data). A webhook is just a NOTIFICATION — the
 * authoritative transactions are always retrieved through `/transactions/sync`.
 * Idempotent by `bodyHash` (an identical re-delivery is deduped). Not tied to a
 * user via the body — the connection is resolved server-side by providerItemId. */
export const plaidWebhookEvents = pgTable(
  "plaid_webhook_events",
  {
    id: serial("id").primaryKey(),
    provider: varchar("provider", { length: 40 }).notNull().default("plaid"),
    environment: varchar("environment", { length: 20 }).notNull().default("sandbox"),
    webhookType: varchar("webhook_type", { length: 60 }).notNull(),
    webhookCode: varchar("webhook_code", { length: 80 }).notNull(),
    // Non-secret Plaid item_id (used to resolve the connection server-side).
    providerItemId: varchar("provider_item_id", { length: 255 }).notNull(),
    providerRequestId: varchar("provider_request_id", { length: 120 }),
    // SHA-256 hex of the verified raw body — the durable idempotency key.
    bodyHash: varchar("body_hash", { length: 64 }).notNull(),
    status: webhookEventStatus("status").notNull().default("received"),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastErrorCode: varchar("last_error_code", { length: 80 }),
    lastErrorMessage: varchar("last_error_message", { length: 300 }),
    ...timestamps,
  },
  (t) => [
    index("plaid_webhook_events_status_idx").on(t.status, t.webhookCode),
    index("plaid_webhook_events_item_idx").on(t.providerItemId),
    // Durable idempotency: an identical re-delivery (same verified body) dedups.
    uniqueIndex("plaid_webhook_events_body_hash_uq").on(t.bodyHash),
  ],
);

/* ----------------------------------------- transaction matching (1B.4A) --- */

// Finance 1B.4A: deterministic, SUGGESTION-ONLY matching between imported bank
// evidence and the owner's finance records. A suggestion never mutates either
// side — only an explicit owner confirmation does, and only through the existing
// approved bill/income workflows (transfers + linked-account income are reported
// as a model gap and fail closed). No AI, no money movement, Sandbox-only.
export const matchSuggestionType = pgEnum("match_suggestion_type", ["bill_payment", "income_receipt", "transfer_pair"]);
// pending → owner-decidable. confirmed/rejected are terminal owner decisions
// (preserved for audit). superseded = no longer valid (e.g. a referenced record
// changed / a transaction was removed) — never silently deleted.
export const matchSuggestionStatus = pgEnum("match_suggestion_status", ["pending", "confirmed", "rejected", "superseded"]);
export const matchConfidence = pgEnum("match_confidence", ["high", "medium", "low"]);

export const transactionMatchSuggestions = pgTable(
  "transaction_match_suggestions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    suggestionType: matchSuggestionType("suggestion_type").notNull(),
    status: matchSuggestionStatus("status").notNull().default("pending"),
    // Imported-transaction evidence. `primary` is the bill/income transaction, or
    // the OUTFLOW side of a transfer pair; `secondary` is the transfer INFLOW side.
    primaryTransactionId: integer("primary_transaction_id")
      .notNull()
      .references(() => importedTransactions.id, { onDelete: "cascade" }),
    secondaryTransactionId: integer("secondary_transaction_id").references(() => importedTransactions.id, { onDelete: "cascade" }),
    // Exactly one finance-record reference is set, matching `suggestionType`
    // (transfer_pair references neither — both sides are imported transactions).
    billId: integer("bill_id").references(() => financialEntries.id, { onDelete: "cascade" }),
    incomeOccurrenceId: integer("income_occurrence_id").references(() => incomeEntries.id, { onDelete: "cascade" }),
    transferId: integer("transfer_id").references(() => accountTransfers.id, { onDelete: "set null" }),
    score: integer("score").notNull(), // deterministic 0–100
    confidence: matchConfidence("confidence").notNull(),
    // Bounded, explainable reason codes (JSON array of short codes — never a raw
    // payload, never an unexplained number alone).
    reasonCodes: text("reason_codes").notNull(),
    amountDifference: numeric("amount_difference", { precision: 14, scale: 2 }),
    dateDifferenceDays: integer("date_difference_days"),
    // Deterministic dedup identity for a candidate relationship. Idempotent
    // regeneration upserts by this key; a rejected identical relationship keeps
    // its row (and its `rejected` status) and is NEVER silently reopened.
    matchKey: varchar("match_key", { length: 240 }).notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    rejectionReason: varchar("rejection_reason", { length: 300 }),
    ...timestamps,
  },
  (t) => [
    index("transaction_match_suggestions_user_status_idx").on(t.userId, t.status),
    index("transaction_match_suggestions_primary_idx").on(t.primaryTransactionId),
    index("transaction_match_suggestions_type_idx").on(t.suggestionType),
    // One row per candidate relationship per owner → idempotent generation.
    uniqueIndex("transaction_match_suggestions_key_uq").on(t.userId, t.matchKey),
  ],
);

/* ------------------------------------ evidence confirmation (1B.4B) -------- */

// Finance 1B.4B: an owner-confirmed relationship between imported bank evidence
// and a planned financial event. `manual_workflow` = the existing manual-domain
// completion (a movement was written, e.g. manual-destination income). The new
// `linked_evidence` mode records that imported transactions PROVE a linked-account
// event happened, WITHOUT any movement/balance/snapshot/cursor change (the money
// already lives in the provider-authoritative linked balance).
export const eventEvidenceType = pgEnum("event_evidence_type", ["income_receipt", "transfer"]);
export const eventConfirmationMode = pgEnum("event_confirmation_mode", ["manual_workflow", "linked_evidence"]);

export const financialEventEvidence = pgTable(
  "financial_event_evidence",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    eventType: eventEvidenceType("event_type").notNull(),
    confirmationMode: eventConfirmationMode("confirmation_mode").notNull(),
    // Exactly one event reference matches `eventType` (income → incomeOccurrenceId;
    // transfer → transferId, which may be null when no planned transfer row exists —
    // the two imported transactions are themselves the durable proof).
    incomeOccurrenceId: integer("income_occurrence_id").references(() => incomeEntries.id, { onDelete: "cascade" }),
    transferId: integer("transfer_id").references(() => accountTransfers.id, { onDelete: "set null" }),
    // Imported-transaction evidence: income references exactly one; a transfer
    // references exactly two (an outflow `primary` + an inflow `secondary`).
    primaryTransactionId: integer("primary_transaction_id")
      .notNull()
      .references(() => importedTransactions.id, { onDelete: "cascade" }),
    secondaryTransactionId: integer("secondary_transaction_id").references(() => importedTransactions.id, { onDelete: "cascade" }),
    confirmedAmount: numeric("confirmed_amount", { precision: 14, scale: 2 }).notNull(),
    confirmedDate: date("confirmed_date"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).defaultNow().notNull(),
    // Deterministic identity → idempotent confirmation + no duplicate evidence.
    eventKey: varchar("event_key", { length: 240 }).notNull(),
    ...timestamps,
  },
  (t) => [
    index("financial_event_evidence_user_idx").on(t.userId, t.eventType),
    index("financial_event_evidence_income_idx").on(t.incomeOccurrenceId),
    index("financial_event_evidence_primary_idx").on(t.primaryTransactionId),
    // One evidence relationship per owner per event → idempotent + no duplicates.
    uniqueIndex("financial_event_evidence_key_uq").on(t.userId, t.eventKey),
  ],
);

/* ----------------------------------- transaction categories (1B.5A) ------- */

// Finance 1B.5A: owner-editable spending categories + DESCRIPTIVE-ONLY category
// assignments on imported transactions + explicit owner-approved merchant rules.
// Categorization is metadata stored SEPARATELY — it never mutates the immutable
// imported-transaction bank evidence (amount/date/pending/cursor/provider state)
// and never moves money. No AI; deterministic suggestions only.
export const transactionCategoryKind = pgEnum("transaction_category_kind", ["expense", "income", "transfer", "neutral"]);
export const categoryAssignmentSource = pgEnum("category_assignment_source", ["owner", "merchant_rule", "deterministic_suggestion"]);
export const categoryAssignmentStatus = pgEnum("category_assignment_status", ["suggested", "confirmed", "rejected", "superseded"]);
export const merchantRuleMatchType = pgEnum("merchant_rule_match_type", ["exact_normalized_merchant", "description_contains", "description_starts_with"]);
export const merchantRuleBehavior = pgEnum("merchant_rule_behavior", ["suggest", "auto"]);

export const transactionCategories = pgTable(
  "transaction_categories",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 80 }).notNull(),
    slug: varchar("slug", { length: 80 }).notNull(), // stable id used by the default bootstrap
    kind: transactionCategoryKind("kind").notNull().default("expense"),
    isSystem: boolean("is_system").notNull().default(false), // a default-bootstrapped category
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index("transaction_categories_user_idx").on(t.userId, t.isActive),
    // Stable slug per owner → idempotent default bootstrap (no duplicate defaults).
    uniqueIndex("transaction_categories_user_slug_uq").on(t.userId, t.slug),
  ],
);

export const transactionCategoryAssignments = pgTable(
  "transaction_category_assignments",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    transactionId: integer("transaction_id").notNull().references(() => importedTransactions.id, { onDelete: "cascade" }),
    categoryId: integer("category_id").notNull().references(() => transactionCategories.id, { onDelete: "cascade" }),
    source: categoryAssignmentSource("source").notNull(),
    status: categoryAssignmentStatus("status").notNull(),
    ruleId: integer("rule_id"), // FK added after merchant_category_rules (avoid a cycle); nullable
    confidence: integer("confidence"), // 0–100 for suggestions; null for owner picks
    reasonCodes: text("reason_codes").notNull().default("[]"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).defaultNow().notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("transaction_category_assignments_user_idx").on(t.userId, t.status),
    index("transaction_category_assignments_txn_idx").on(t.transactionId),
    // At most ONE current confirmed + ONE current suggested per transaction
    // (concurrency-safe; history rows are superseded/rejected).
    uniqueIndex("transaction_category_assignments_confirmed_uq").on(t.transactionId).where(sql`status = 'confirmed'`),
    uniqueIndex("transaction_category_assignments_suggested_uq").on(t.transactionId).where(sql`status = 'suggested'`),
  ],
);

export const merchantCategoryRules = pgTable(
  "merchant_category_rules",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    matchType: merchantRuleMatchType("match_type").notNull().default("exact_normalized_merchant"),
    matchValue: varchar("match_value", { length: 200 }).notNull(), // owner-facing match text
    normalizedMatchValue: varchar("normalized_match_value", { length: 200 }).notNull(), // Xanther-owned
    categoryId: integer("category_id").notNull().references(() => transactionCategories.id, { onDelete: "cascade" }),
    behavior: merchantRuleBehavior("behavior").notNull().default("suggest"), // suggest (default) | auto
    priority: integer("priority").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    applyToExisting: boolean("apply_to_existing").notNull().default(false), // record of the owner's choice
    createdFromTransactionId: integer("created_from_transaction_id").references(() => importedTransactions.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("merchant_category_rules_user_idx").on(t.userId, t.isActive),
    // No duplicate ACTIVE rule for the same match (disabled duplicates kept for history).
    uniqueIndex("merchant_category_rules_active_uq").on(t.userId, t.matchType, t.normalizedMatchValue).where(sql`is_active`),
  ],
);

/* ------------------------------------- spending insights (1B.5B) ---------- */

// Finance 1B.5B: spending insights + opportunity cards are DETERMINISTIC CALCULATED
// VIEWS recomputed from current transaction data on every request — read-only
// financial intelligence that never mutates a transaction, category, rule, balance,
// movement, bill/income/transfer, provider snapshot, or cursor, and moves no money.
// The ONLY durable lifecycle state is the owner's DISMISSAL of an insight, recorded
// here (keyed by a deterministic insight key that INCLUDES the evidence period, so a
// dismissed insight stays dismissed for that period and can legitimately reappear
// in a new period). Restore = delete the row. No AI. No raw provider payload/secret.
export const financialInsightDismissals = pgTable(
  "financial_insight_dismissals",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    insightKey: varchar("insight_key", { length: 240 }).notNull(), // deterministic: type:period:entity
    insightType: varchar("insight_type", { length: 60 }).notNull(),
    periodKey: varchar("period_key", { length: 40 }).notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }).defaultNow().notNull(),
    ...timestamps,
  },
  (t) => [
    index("financial_insight_dismissals_user_idx").on(t.userId),
    // One dismissal per owner per insight-key → idempotent dismiss, no duplicates.
    uniqueIndex("financial_insight_dismissals_key_uq").on(t.userId, t.insightKey),
  ],
);

/* ---------------------------------------------------- credit (1C.0A) --- */
/* Manual, owner-entered credit profile. NO bureau/Credit-Karma connection,
 * no auto-inference from bank data, no money movement. Type/status fields are
 * server-validated varchars (same convention as financial_accounts.type) to
 * keep the migration minimal + additive. All calculations are read-only. */

export const creditScoreSnapshots = pgTable(
  "credit_score_snapshots",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    score: integer("score").notNull(), // bounded 250–900 in the service
    source: varchar("source", { length: 40 }).notNull(), // experian|equifax|transunion|credit_karma|bank|lender|other
    bureau: varchar("bureau", { length: 40 }), // nullable — bureau behind the score if known
    scoringModel: varchar("scoring_model", { length: 60 }), // nullable — e.g. FICO 8, VantageScore 3
    asOfDate: date("as_of_date").notNull(),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [
    index("credit_score_snapshots_user_idx").on(t.userId),
    // One snapshot per (owner, source, model, date, score) → idempotent, no silent duplicate.
    // Partial: only LIVE rows participate, so a soft-deleted snapshot never blocks
    // (or silently swallows) an identical re-entry.
    uniqueIndex("credit_score_snapshots_uq").on(t.userId, t.source, t.scoringModel, t.asOfDate, t.score).where(sql`${t.deletedAt} is null`),
  ],
);

export const creditAccounts = pgTable(
  "credit_accounts",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    accountType: varchar("account_type", { length: 30 }).notNull(), // credit_card|secured_card|auto_loan|personal_loan|student_loan|mortgage|retail_card|other
    name: varchar("name", { length: 120 }).notNull(),
    issuer: varchar("issuer", { length: 120 }),
    status: varchar("status", { length: 20 }).notNull().default("open"), // open|closed|charged_off|delinquent|unknown
    isRevolving: boolean("is_revolving").notNull().default(false),
    creditLimit: numeric("credit_limit", { precision: 14, scale: 2 }), // nullable — required for revolving utilization
    currentBalance: numeric("current_balance", { precision: 14, scale: 2 }).notNull().default("0"),
    minimumPayment: numeric("minimum_payment", { precision: 14, scale: 2 }),
    interestRate: numeric("interest_rate", { precision: 6, scale: 3 }), // APR %, nullable
    openedDate: date("opened_date"),
    closedDate: date("closed_date"),
    statementDate: date("statement_date"),
    paymentDueDate: date("payment_due_date"),
    lastReportedDate: date("last_reported_date"),
    isAuthorizedUser: boolean("is_authorized_user").notNull().default(false),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [index("credit_accounts_user_idx").on(t.userId)],
);

export const creditCollections = pgTable(
  "credit_collections",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    collectorName: varchar("collector_name", { length: 160 }).notNull(),
    originalCreditor: varchar("original_creditor", { length: 160 }),
    reportedBalance: numeric("reported_balance", { precision: 14, scale: 2 }).notNull().default("0"),
    status: varchar("status", { length: 20 }).notNull().default("reported"), // reported|disputed|validated|settled|paid|removed|unknown
    dateOpened: date("date_opened"),
    dateReported: date("date_reported"),
    lastUpdatedDate: date("last_updated_date"),
    validationStatus: varchar("validation_status", { length: 24 }).notNull().default("not_requested"), // not_requested|requested|received|incomplete|verified_by_owner
    settlementOffer: numeric("settlement_offer", { precision: 14, scale: 2 }), // owner-entered only
    payForDeleteRequested: boolean("pay_for_delete_requested").notNull().default(false),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [index("credit_collections_user_idx").on(t.userId)],
);

export const creditLatePayments = pgTable(
  "credit_late_payments",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    creditAccountId: integer("credit_account_id").notNull().references(() => creditAccounts.id, { onDelete: "cascade" }),
    daysLate: integer("days_late").notNull(),
    reportedDate: date("reported_date").notNull(),
    amountPastDue: numeric("amount_past_due", { precision: 14, scale: 2 }),
    status: varchar("status", { length: 16 }).notNull().default("reported"), // reported|resolved|disputed|removed
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [
    index("credit_late_payments_user_idx").on(t.userId),
    index("credit_late_payments_account_idx").on(t.creditAccountId),
  ],
);

export const creditInquiries = pgTable(
  "credit_inquiries",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    creditorName: varchar("creditor_name", { length: 160 }).notNull(),
    inquiryDate: date("inquiry_date").notNull(),
    bureau: varchar("bureau", { length: 40 }),
    inquiryType: varchar("inquiry_type", { length: 8 }).notNull().default("hard"), // hard|soft
    purpose: varchar("purpose", { length: 120 }),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [
    index("credit_inquiries_user_idx").on(t.userId),
    // Guard against clearly-identical duplicates (same creditor + date + type).
    // Partial (live-only) for the same reason as scores — a soft-deleted inquiry
    // must not block re-entering an identical one.
    uniqueIndex("credit_inquiries_uq").on(t.userId, t.creditorName, t.inquiryDate, t.inquiryType).where(sql`${t.deletedAt} is null`),
  ],
);

export const creditGoals = pgTable(
  "credit_goals",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    goalType: varchar("goal_type", { length: 30 }).notNull(), // score_target|utilization_target|collection_resolution|on_time_payment_streak|debt_balance_target
    targetValue: numeric("target_value", { precision: 14, scale: 2 }).notNull(),
    targetDate: date("target_date"),
    status: varchar("status", { length: 16 }).notNull().default("active"), // active|achieved|paused|abandoned
    priority: varchar("priority", { length: 8 }).notNull().default("medium"), // low|medium|high
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [index("credit_goals_user_idx").on(t.userId)],
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
