# Data Model

> Source of truth: `db/schema.ts` (Drizzle). The initial SQL migration is
> `db/migrations/0000_init.sql`. This document summarizes that schema — if the two ever
> disagree, **`db/schema.ts` wins** and this file should be corrected. No real/personal
> data appears here.

## Conventions (applied across all domain tables)

- `id` — serial primary key.
- `userId` — FK to `users.id` (`on delete cascade`). Every domain row is user-owned, so
  multi-user is possible later without a rewrite.
- `createdAt` — set on insert.
- `updatedAt` — bumped on update **by the service layer** (not a DB trigger).
- `deletedAt` — **soft delete**. `NULL` means "live"; queries filter on `isNull(deletedAt)`.
  Phase-1 code never hard-deletes domain rows.

## Enums (Postgres `pgEnum`)

`task_status`, `priority`, `recurrence`, `obligation_type`, `obligation_status`,
`importance`, `bill_status`, `balance_source` (Finance 1A.1: `manual`|`linked`),
`movement_kind` (Finance 1A.3A: `bill_payment`|`bill_payment_reversal`; Finance 1A.2 adds
`income_received`|`income_reversal`|`transfer_out`|`transfer_in`|`transfer_out_reversal`|
`transfer_in_reversal`; Finance 1A.3B adds `reconcile_adjustment`|`reconcile_reversal`),
`income_status` (1A.2: `scheduled`|`received`|`cancelled`; 1A.4 adds `skipped`),
`allocation_type` (1A.2: `fixed`|`percent`|`remainder`), `transfer_status` (1A.2:
`scheduled`|`completed`|`reversed`|`cancelled`),
`income_cadence` (1A.4: `one_time`|`weekly`|`biweekly`|`semimonthly`|`monthly`),
`estimate_type` (1A.4: `fixed`|`typical`|`range`|`unknown`), `signal_type`,
`signal_status`, `opportunity_category`,
`opportunity_status`, `feedback_kind`, `job_status`, `interest_status`, `run_status`,
`experience_request_status`, `experience_status`, `experience_energy_level`,
`experience_physical_difficulty`, `experience_interpretation_source`.

## Tables

### Identity
- **`users`** — `email` (unique), `name`.
- **`user_preferences`** — one row per user (unique `userId`); home/work area, search
  radius, transportation, availability, budget, risk tolerance, skills, experience,
  interests, salary range, commute, opportunity interests/exclusions, monitored areas,
  news/entertainment/technology topics. **Not surfaced in the UI yet.**

### Tasks & obligations
- **`tasks`** — `title`, `description`, `dueDate`, `dueTime`, `priority`, `status`,
  `category`, `recurrence`, `notes`, `completedAt`. Indexed on (`userId`,`status`) and `dueDate`.
  **Completion lifecycle:** completing sets `status='completed'` + `completedAt` (a row is **never
  hard-deleted** on completion); it leaves the active list (UI filters `completed`/`cancelled`) but
  is retained and shown under a collapsed "Recently completed" history. **Reopen** (`reopenTask`,
  also the route's `status:"not_started"` path) returns it to the active list and **clears
  `completedAt`**. `deletedAt` is the separate soft-delete. Tasks and **obligations are distinct
  object types** (different tables, fields, and lifecycle — obligations use `done`/`cancelled`/
  `missed`, not task completion) and are surfaced as separate "Act Today" vs "Upcoming Commitments"
  sections; they are never presented as interchangeable.
- **`obligations`** — `title`, `type`, `startDate`, `endDate`, `startTime`, `location`,
  `description`, `importance`, `reminderDate`, `status`, `source`, `externalCalendarId`
  (reserved for future calendar sync, unused).

### Finances
- **`financial_accounts`** — `name`, `type` (validated varchar: checking|savings|cash|credit|other),
  **Finance 1A.1**: `institution` (optional), `purpose` (validated varchar:
  spending|bills|savings|emergency|cash|other; existing rows default `'other'`, never guessed),
  `currentBalance` (manually entered actual balance; for **credit** accounts this is the amount
  **owed** — a liability, positive = you owe — and is never counted as cash), `balanceSource`
  (`balance_source` enum `manual`|`linked`, default `manual`; `linked` is reserved for a future
  read-only bank connection and is unused), `includeInSpendable` (bool, default `true`), `active`
  (bool, default `true`), `balanceUpdatedAt`, `notes`. **No bank connection.** Provider/connection-
  health fields are deliberately **not** here — a future connection may back several accounts, so
  that lives in a separate `financial_connections` model later (Finance 1B). No `lastReconciledAt`
  (reconciliation is Finance 1A.3).
  - **Cash/liability rules** (`computeCashSummary`, pure): only **active** accounts count; **total
    actual cash** = Σ balance over active cash-type accounts; **spendable** = the `includeInSpendable`
    subset (savings/emergency default excluded; credit forced excluded); **savings/emergency** = Σ
    over active accounts whose purpose is savings|emergency (surfaced separately, still within total
    cash); **credit liabilities** = Σ over active credit accounts; `netPosition = totalActualCash −
    creditLiabilities`. Credit is **never** added to any cash total.
- **`recurring_bills`** — template: `name`, `expectedAmount`, `minimumPayment`,
  `dueDayOfMonth`, `recurrence`, `active`. **No instance generation implemented yet.**
- **`financial_entries`** — concrete bills/income instances; `kind` = `bill | income`,
  optional `recurringBillId`, `dueDate`, `expectedAmount`, `actualAmount`, `status`,
  `paidAt`. **Finance 1A.1**: `sourceAccountId` (account a bill is normally paid from) and
  `paidAccountId` (account actually used when marked paid) — **both nullable FKs to
  `financial_accounts`**; a null `sourceAccountId` renders as "Payment account not assigned"
  (never auto-guessed or back-filled). **Finance 1A.3A** makes paying a bill a balance-changing,
  ledgered action: marking a bill paid records status + `paidAt` + `paidAccountId` + `actualAmount`,
  and — when paid from a **manual** account — atomically deducts that account and writes one
  `account_movements` row (external/cash and `linked` accounts change no balance). (Finance services
  use `kind = "bill"` rows for bills.)
- **`account_movements`** (Finance 1A.3A) — **append-only** ledger of every change a recorded bill
  payment makes to a **manual** account balance: `userId`, `accountId` (FK, the account changed),
  `billId` (FK, nullable), `kind` (`movement_kind`: `bill_payment` = negative, `bill_payment_reversal`
  = positive), `amount` (signed `numeric(14,2)`), `reversalOfId` (self-FK; set on a reversal →
  the payment it undoes), `note`, `occurredAt`, `createdAt`. **No `updatedAt`/`deletedAt`** — rows are
  never updated or deleted; corrections happen by appending a reversal. A **partial unique index on
  `reversal_of_id`** guarantees at most one reversal per payment (no double credit). External/cash
  payments and payments against `linked` accounts create **no** movement. Scope is the bill-payment
  ledger only — income/transfer/reconciliation movement kinds are deliberately **not** added (future
  Finance 1A.3 / 1A.2).
- **`income_entries`** — `source`, `expectedAmount`, `actualAmount`, `payDate`, `recurrence`,
  `isPayday`. **Finance 1A.2**: `destinationAccountId` (single-destination mode; null = unassigned or
  split), `status` (`income_status`, default `scheduled`), `receivedAt`. A scheduled income changes no
  balance; receiving it credits its destination(s) and stores `actualAmount` + `receivedAt`. Existing
  income defaulted to `scheduled` with no destination and shows "Destination not assigned" (never
  guessed). Managed on **`/finances`** (moved off `/manage` in 1A.2).
  **Finance 1A.4**: `scheduleId` (FK `income_schedules`, null = standalone one-time income),
  `estimateType` (`estimate_type`, default `fixed`), `expectedMin`/`expectedMax` — copied from the
  schedule at generation so each occurrence is self-contained for projection; **`scheduledFor`** (the
  rule date the occurrence fills — survives a date override; generation skips a rule date already
  claimed by a live occurrence's `scheduled_for`) and **`isOverridden`** (true once the owner edits the
  individual occurrence — never regenerated/overwritten by a schedule edit; tracked explicitly, never
  inferred from value diffs). A partial unique index on `(schedule_id, pay_date)` (where both non-null)
  makes generation idempotent.
- **`income_schedules`** (Finance 1A.4) — the reusable recurring-income RULE: `source`, `cadence`
  (`income_cadence`), `anchorDate`, `expectedAmount` + `estimateType` + `expectedMin`/`expectedMax`,
  `destinationAccountId`, `dayOfMonth` (monthly), `dayA`/`dayB` (semimonthly — a day past month-end
  resolves to the last calendar day), `isPayday`, `active`, `endDate`, soft-delete. Occurrences are
  materialized into `income_entries`; a schedule never stores individual paychecks itself.
- **`income_schedule_allocations`** (Finance 1A.4) — schedule-level split rows (snapshot source);
  copied into `income_allocations` for each generated occurrence so later schedule edits never rewrite
  an already-received occurrence. Unique `(scheduleId, accountId)`.
- **`income_allocations`** (Finance 1A.2) — split rows for one income: `incomeId` (FK, cascade),
  `accountId` (FK), `allocationType` (`fixed`|`percent`|`remainder`), `value` (dollars for fixed,
  percent for percent, null for remainder), `position`. **Resolution order: fixed → percent OF THE
  AMOUNT REMAINING AFTER fixed → remainder**, computed in **integer cents** (no float drift); the
  remainder (or, with no remainder row, the last share) absorbs the deterministic rounding so shares
  always sum exactly to gross. Constraints: at most one remainder; percent total ≤ 100; **unique
  `(incomeId, accountId)`** (no duplicate destination); fixed ≤ gross (checked at receipt). Without a
  remainder, percents must total exactly 100% (or a fixed-only set must equal gross).
- **`account_transfers`** (Finance 1A.2) — a transfer between two owned accounts: `fromAccountId`,
  `toAccountId`, `amount`, `scheduledDate`, `status` (`transfer_status`), `completedAt`, `note`,
  soft-delete. A scheduled transfer changes no balance; **completing** a manual→manual transfer moves
  both balances + writes paired `transfer_out`/`transfer_in` movements; **reverse** restores them.
  Source ≠ destination, amount > 0, both owned/active/non-credit; an internal transfer is never income
  or spending and **never changes total owned cash**.
- **`account_movements`** also gained **`incomeId`** + **`transferId`** FK references (1A.2) alongside
  the existing `billId` — exactly one is set per row (or none, for reconciliation), matching `kind`.
  Income receipt and transfer completion/reversal append rows here exactly like bill payments;
  reversals link via `reversalOfId` and the partial unique index still guarantees no double credit/debit.
  **Finance 1A.3B** added **`priorBalance`** + **`newBalance`** (set only on `reconcile_*` rows — the
  manual actual balance before/after the adjustment, enabling a safe reversal); `financial_accounts`
  gained **`lastReconciledAt`** (when the manual balance was last verified vs the bank; null = never).
  Reconciliation is modeled in this one ledger (no separate table) — the smallest auditable, reversible
  model: a `reconcile_adjustment` carries the signed delta + prior/new balance; its `reconcile_reversal`
  restores `priorBalance` and re-derives `lastReconciledAt` from the remaining unreversed reconciles.

**Account-aware projection (Finance 1A.3B) — read-model, NO schema.** `lib/services/finance-projection.ts`
is a pure function: `projected = actual + scheduled inflows − scheduled outflows` within a horizon
(`7d` / `payday` / `30d`). It NEVER writes the DB or overwrites `currentBalance`. Only **scheduled**
items project (open bills by source account; scheduled income via single destination or the
fixed→percent-of-remaining→remainder split used at receipt; scheduled manual↔manual transfers, net
zero). Paid bills, received income, and completed/reversed transfers are already in the actual balance
and are never counted again. Unassigned bills/income are surfaced (never guessed into an account);
linked-account items are excluded with a warning; credit liabilities stay separate from cash.

**Recurring income + estimates (Finance 1A.4).** Recurrence dates are generated by the pure
`lib/finance-recurrence.ts` (`generateOccurrenceDates`, UTC-anchored calendar math; the app timezone
supplies "today"). The schedule service (`lib/services/income-schedules.ts`) materializes a bounded
rolling window of occurrences into `income_entries` (idempotent; never resurrects deleted/received
occurrences). **Estimate → projection amount:** `fixed`/`typical` → expected; `range` → **minimum**
(conservative, documented); `unknown` → **$0** (the payday still appears). Estimated income is never
treated as confirmed cash. **Variance** (actual − expected, $ and %) is computed in the view after
receipt. **Schedule-edit rule:** a field/split edit regenerates only FUTURE, still-`scheduled`, **non-overridden**
occurrences (delete + recreate from the new rule); received/skipped/cancelled/reversed/past **and
individually-overridden** occurrences are preserved, and `scheduled_for` prevents a duplicate on the
original or moved date. **Archive vs hard-delete:** removing a schedule that has ANY occurrence/history
**archives** it (soft-delete + pause — all occurrences + ledger movements stay intact and readable, no
new generation); only a genuinely unused schedule is hard-deleted. The `income_entries.schedule_id` and
`account_movements.income_id` FKs are **`ON DELETE no action`** — the DB cannot cascade-delete income
occurrences or ledger history (a hard-delete with history is rejected).
**Next-income wording:** `payday` only when an active recurring payday occurrence is next, else
`scheduled` (one-time/non-payroll), else `none` — the horizon never falsely claims "next payday".
**Future bank-sync readiness (recorded, NOT implemented):** imported deposits will later match expected
occurrences (possibly several deposits → one paycheck), replace estimates with actuals, and must not
duplicate manual income movements; uncertain matches need owner approval; recurring detection may
*suggest* a schedule but never silently create one.

**Finance roadmap:**
- **1A.2 — DONE** — account-linked & **split income** (fixed → percent-of-remaining → remainder,
  integer-cent, deterministic rounding to the remainder/last share) and **transfers** between owned
  accounts (scheduled + completed; two-leg, net-zero, never income/expense), both ledger-backed and
  reversible. Linked accounts are never manually mutated; **future matching with imported bank
  transactions** (Finance 1B) will reconcile these manual movements against synced transactions.
- **1A.3A — DONE** — the **manual bill-payment ledger** (`account_movements`): paying a bill from a
  manual account atomically deducts it + appends a movement; reversal credits it back + appends an
  equal positive movement; idempotent/concurrency-safe; no double spend or double credit.
- **1A.3A — DONE** — manual bill-payment ledger (see above).
- **1A.3B — DONE** — manual-account **reconciliation** (set actual to the real bank balance with an
  auditable `reconcile_adjustment` + undo) and deterministic **account-aware projection** (actual +
  scheduled inflows − scheduled outflows by horizon). The legacy `estimatedRemaining` remains as a
  compatibility figure on `/manage`; Home + `/finances` now lead with truthful actual-vs-projected.
- **1A.4 — DONE** — recurring income schedules + estimate-vs-confirmed paychecks (see above).
- **1B (future)** — read-only bank connections (`balanceSource = linked`) **replace manual
  reconciliation**; imported transactions confirm bills/income/transfers (incl. matching recurring
  income occurrences — possibly several deposits to one paycheck); manual movements must not duplicate
  imported transactions; matching attaches evidence to scheduled records, with owner approval for
  uncertain matches; recurring detection may suggest but never silently create a schedule.
- **1B** — a separate **`financial_connections`** model for read-only bank links (`balanceSource =
  linked`); connection health lives there, not on the account row.
- **1B.2 — DONE (Plaid Sandbox accounts + cached balances)** — additive migration
  `0012_loud_barracuda.sql` adds the `provider_account_status` enum (`active|stale`) + the
  **`provider_accounts`** table: one row per discovered provider account — `userId`, `connectionId`,
  `provider`, `providerAccountId` (unique within `(connection_id, provider_account_id)`),
  `financialAccountId` (nullable; partial-unique so one Xanther account ↔ one provider account),
  `providerName`/`officialName`/`mask` (last-4 only), `providerType` (normalized) + `providerSubtype`
  (raw display), `currencyCode`, cached `balanceCurrent`/`balanceAvailable`/`balanceLimit`,
  `balanceAsOf` (freshness), `status`, `firstSeenAt`/`lastSeenAt`, timestamps. **No token, cursor,
  imported transactions, or raw Plaid payload.** A **new linked** `financial_accounts` row
  (`balanceSource='linked'`, `currentBalance` NULL — the provider snapshot is authoritative) is created
  from an unmapped provider account; existing **manual** accounts are never mapped/converted (deferred).
  View models: `ProviderAccountView` (nonsecret), `AccountView` gains linked-balance fields,
  `CashSummary` gains linked unavailable/stale qualification. **The `provider_accounts.connection_id`
  FK is `ON DELETE NO ACTION` (migration `0013`, constraint-only)** so a connection can't be hard-deleted
  while any provider account still references it — preventing an orphaned linked account; the
  `financial_account_id` FK is also `NO ACTION`. See `docs/DECISIONS.md` ADR-029.
- **1B.3A — DONE (Plaid Sandbox transaction import)** — additive migration `0014_bouncy_arclight.sql`
  adds the `imported_transaction_status` enum (`active|removed`) + the **`imported_transactions`** table:
  `userId`, `connectionId` (FK cascade), `providerAccountId`, `financialAccountId` (FK **SET NULL**),
  `provider`, `providerTransactionId` (unique within `(connection_id, provider_transaction_id)`),
  `pendingProviderTransactionId`, `status`, `isPending`, `amount` (**Xanther-signed**; $0 skipped),
  `currencyCode`, `descriptionOriginal`/`descriptionCurrent`, `merchantName`, `authorizedDate`/
  `postedDate`, bounded `categoryPrimary`/`categoryDetailed`, `firstSeenAt`/`lastUpdatedAt`/`removedAt`,
  timestamps. **Bank EVIDENCE only — never an `account_movements` row, balance mutation, or
  bill/income/transfer confirmation; no raw payload/token/cursor stored here.** `financial_connections`
  gains 6 nullable transaction-sync columns (`transactions_cursor`, `last_transaction_sync_attempted_at`/
  `_synced_at`, `transaction_sync_locked_at` = per-connection lock, error code/message). The committed
  cursor advances only after every page persists; removed→tombstone; pending→posted suppression avoids
  double-counting. View model: `ImportedTransactionView` (nonsecret — no provider txn id/account number).
- **1B.3B — DONE (verified webhooks + automatic sync)** — additive migration `0015_bouncy_mandrill.sql`
  adds the `webhook_event_status` enum (`received|processing|processed|failed|ignored`) + the
  **`plaid_webhook_events`** table: `provider`, `environment`, `webhookType`, `webhookCode`,
  `providerItemId` (resolves the connection server-side), `providerRequestId`, `bodyHash` (**unique** —
  durable idempotency key), `status`, `receivedAt`/`processingStartedAt`/`processedAt`, `attemptCount`,
  bounded `lastErrorCode`/`lastErrorMessage`, timestamps. **Stores NO token, encryption field, raw
  payload, account number, or transaction data.** No FK to a user — the webhook is verified
  cryptographically and the connection is resolved by `providerItemId`. `financial_connections` is
  unchanged (the existing transaction-sync state is reused).
  See `docs/DECISIONS.md` ADR-030.
- **1B.4A — DONE (deterministic transaction-matching suggestions)** — additive migration
  `0016_curved_nekra.sql` adds enums `match_suggestion_type` (`bill_payment|income_receipt|transfer_pair`),
  `match_suggestion_status` (`pending|confirmed|rejected|superseded`), `match_confidence`
  (`high|medium|low`) + the **`transaction_match_suggestions`** table: `userId`, `suggestionType`,
  `status`, `primaryTransactionId` (FK imported_transactions; the bill/income txn or transfer outflow
  side), `secondaryTransactionId` (FK; transfer inflow side), `billId`/`incomeOccurrenceId`/`transferId`
  (exactly one set, matching the type; transfer pairs reference neither), `score` (0–100), `confidence`,
  `reasonCodes` (JSON array of bounded codes), `amountDifference`, `dateDifferenceDays`, `matchKey`
  (**unique per `(userId, matchKey)`** — idempotent generation + dedup; a rejected identical relationship
  keeps its row and is never reopened), `reviewedAt`, `rejectionReason`, timestamps. **Stores NO raw Plaid
  payload, token, or provider secret.** Ownership is server-derived. A suggestion is SUGGESTION-ONLY —
  it mutates neither side; only an owner confirmation applies an effect, and only through the existing
  `payBill`/`receiveIncome` workflows (transfer + linked-destination income confirmation fail closed —
  model gap). The confirmed suggestion row IS the durable evidence link; **no columns were added to
  bills/income/transfers.** See `docs/DECISIONS.md` ADR-033.
- **1B.1 — DONE (Plaid Sandbox connect)** — additive migration `0011_rapid_sasquatch.sql` adds the
  `connection_status` enum + the **`financial_connections`** table: `userId`, `provider` (`plaid`),
  `providerItemId` (unique within `(user_id, provider)`), `institutionId`/`institutionName`, the
  **encrypted access-token envelope** (`access_token_cipher`/`_nonce`/`_tag`/`_key_version`/
  `_envelope_version` — **no plaintext token column**), `status`, `environment` (`sandbox`),
  `consentGrantedAt`, `lastSyncAttemptedAt`/`lastSyncedAt`, `requiresReauth`, bounded redacted
  `errorCode`/`errorMessage`, `disconnectedAt`, timestamps. Read-only; **no accounts/balances/
  transactions/mappings yet**. View model: `ConnectionView` (nonsecret — omits every encrypted field).
- **1B.0 — DONE (foundation only; no DB change)** — provider-neutral contracts + security model, **no
  tables yet**. Added `lib/providers/*` (the `BankProvider` interface + DTOs, a canonical
  transaction-sign convention `inflow + / outflow − / 0 invalid`, a pure balance-authority resolver,
  and an AES-256-GCM token-encryption module) and `docs/BANK_INTEGRATION_SECURITY.md`. **Proposed**
  additive tables (designed, NOT created): `financial_connections` (encrypted access-token envelope +
  status + per-connection `transactions` cursor), `provider_account_mappings` (connection-scoped
  provider account id ↔ `financial_accounts`), `imported_transactions` (revision-aware evidence,
  Xanther-signed amounts, pending/posted/removed), `connection_sync_requests` + `connection_sync_runs`
  (durable webhook-triggered sync state), `transaction_matches` (owner-confirmed match evidence,
  supports split-deposit many-to-one). **Balance authority:** manual ← `currentBalance`; linked ←
  provider snapshot (authoritative, with `asOf`); a missing linked balance is `unavailable`, never the
  manual balance. **Imported transactions are evidence, never `account_movements` commands** — a linked
  match creates no balance movement. See `docs/DECISIONS.md` ADR-027.

### Signals & opportunities
- **`signal_sources`** — ingest sources (`name`, `baseUrl`, `kind`, `active`). Unused by UI.
- **`signals`** — `title`, `summary`, `type`, source fields, dedup fields
  (`normalizedUrl`, `externalId`, `contentHash`, `duplicateOf`, `isDuplicate`),
  `location`, date fields, `relevanceScore`/`urgencyScore`/`confidenceScore`, `status`,
  `isMock`. Partial unique indexes guard against duplicate URL/hash per user.
- **`opportunities`** — `title`, `summary`, `category`, narrative fields, time window,
  `startupCost`, effort/risk, scores, `potentialValue`, jsonb arrays (open questions,
  obstacles, next actions, source links), `status`, `generatedBy` (`manual` today).
- **`opportunity_signals`** — M:N join between opportunities and signals. Unused by UI.
- **`opportunity_feedback`** — append-only feedback log (`kind`, `note`). Unused by UI.

### Jobs & interests
- **`jobs`** — `title`, `company`, `location`, salary range, `employmentType`,
  `workArrangement`, descriptions, source fields, `matchScore`, `status`, `isMock`.
- **`interest_topics`** — named topics per user (`name`, `active`). Interest items
  reference these; the interest service finds-or-creates a topic by name.
- **`interest_items`** — `topicId` (FK), `title`, `summary`, `source`, `publishedDate`,
  `whyItMatters`, `relevanceScore`, `status`, `isMock`.

### Experience and Adventure Loop (Build 1 manual + Build 2A interpretation)
Two durable entities; **no separate recommendations table** (deferred). Recommendation columns
(recommendations JSON, `selectedRecommendationId`) remain **deferred to Build 2B**. Build 2A
added AI interpretation **provenance** to `experience_requests` (see below).
- **`experience_requests`** — the desired experience + constraints: `requestText`,
  `availableDate`, `availableTimeText`, `budgetMax`, `startingLocation` (prefilled from
  `user_preferences.homeArea` but request-specific/editable — never written back),
  `maxTravelMiles` + `maxTravelMinutes` (independent; never converted), `energyLevel`,
  `desiredFeeling`, `maxPhysicalDifficulty`, `interests`/`exclusions` (jsonb string[]),
  `status` (`draft` → `interpreted` → `recommendations_ready` → `planned`), and **Build 2A
  provenance**: `interpretationSource` (`experience_interpretation_source`: `manual` | `ai`,
  default `manual`), `interpretationProvider` (e.g. `anthropic`), `interpretationModel` (the
  exact model id used). Editing any AI-filled constraint resets `interpretationSource` to
  `manual` and clears provider/model; editing only `requestText` does not.
  **Build 2B.1 recommendations:** `recommendations` (jsonb, `not null default []`, a validated
  `ExperienceRecommendation[]` — never raw model output), `recommendationSource`
  (nullable `experience_interpretation_source`, `ai` when generated), `recommendationProvider`,
  `recommendationModel` (bounded text). The batch is **replaced wholesale** on regeneration and
  **cleared** (with provenance, reverting status to `interpreted`) when the request text or any
  interpreted constraint changes.
- **`experiences`** — a planned/resolved experience: required `requestId` FK, `title`,
  `description`, `plannedDate`, `plannedTimeText`, `locationText`, `expectedCost`,
  `actualCost`, `expectedDurationMinutes`, `physicalDifficulty`, `desiredFeeling`, `notes`,
  `status` (`planned` → `completed`/`cancelled`/`not_completed`, one-way), `completedAt`,
  `resolvedAt`, `nonCompletionReason`, `rating` (1–5), `reflection`, `meaningfulExperience`
  (owner-controlled bool), `adventureXp` (server-computed: 10 / 15 / 0), and **Build 2B.2**
  `selectedRecommendationId` (`varchar(64)`, nullable — the app-assigned recommendation id this
  plan was created from, or null for a manual plan; drives the "From AI suggestion" badge and
  deletion-recovery routing). A partial unique index on `request_id` (where `deleted_at is null`)
  enforces one live experience per request and backstops the atomic selection write.

**Request lifecycle transitions:**
- `draft → interpreted` when owner-triggered AI interpretation succeeds and writes
  constraints (Build 2A). A re-interpretation of an `interpreted` request stays `interpreted`.
- `draft`/`interpreted`/`recommendations_ready → recommendations_ready` when owner-triggered
  recommendation generation succeeds (Build 2B.1). Regeneration replaces the batch with new ids.
- `recommendations_ready → interpreted` (clear-on-edit) when the request text or any interpreted
  constraint changes — the stored batch + recommendation provenance are cleared, no AI call.
- `draft`/`interpreted`/`recommendations_ready → planned` when a plan (experience) is created
  from the request — either manually (Build 1, `selected_recommendation_id = null`) or by
  **choosing a recommendation** (Build 2B.2). The recommendation path is a **single atomic
  writable-CTE statement** that re-checks owner/not-deleted/`recommendations_ready`/id-in-current-
  batch, transitions the request to `planned`, and inserts the experience both-or-neither; the
  recommendation **batch is retained** for traceability. (`experience_request_status = closed` is
  still intentionally **not** added until a close/archive workflow exists.)
- **Planned-experience deletion recovery (Build 2B.2 refinement of ADR-010):** soft-deleting a
  `planned` experience returns its request to `recommendations_ready` **if** its
  `selected_recommendation_id` is still in the request's current batch; otherwise (a manual plan,
  or a batch that has since changed) to `draft`. The batch is never cleared, no AI call is made,
  and a **resolved** experience's deletion never reactivates the request.
- `planned → draft` when its live **planned** experience is soft-deleted (recovery, so the
  request is re-plannable). All constraint data is preserved. (Recovery returns to `draft`,
  not `interpreted`, even if it had been AI-interpreted — provenance fields are retained.)
- Soft-deleting an **already-resolved** experience does **not** reopen the request (stays
  `planned`). See `docs/DECISIONS.md` ADR-010.

**Recommendation contract (`ExperienceRecommendation`, in `lib/types.ts`):** `id` (app-assigned
`rec_<uuid>` — the model never controls ids), `title`, `description`, `whyItFits`,
`estimatedCostMin`/`estimatedCostMax`, `estimatedDurationMinutes`, `locationText`,
`travelAssumption`, `physicalDifficulty`, `intendedFeeling`, `assumptions[]`, `preparationNotes[]`.
Validated as a whole batch of exactly three (`lib/ai/recommendation-schema.ts`); any violation
rejects the entire batch with no partial persistence. These are concepts, not verified facts.

### Intelligence / operations (reserved; no UI/logic yet)
- **`intelligence_settings`** — one row per user; `aiAutomationEnabled`, `killSwitch`,
  daily/monthly call & search limits, monthly cost limit, `lastSuccessfulRun`. The master
  gate for AI/automation — **now read by the Build 2A interpretation orchestration**
  (`lib/services/ai-experience.ts`) alongside the `AI_AUTOMATION_ENABLED` env flag and an
  `ANTHROPIC_API_KEY`. No settings UI yet (edited directly in the DB).
- **`api_usage_logs`** — provider/operation/token/cost ledger. Builds 2A and 2B.1 **write** one
  bounded row per AI attempt (success or failure): provider, operation (`experience_interpret` /
  `experience_recommend`), token counts, estimated cost, success flag, and an error *category* —
  never prompts, request text, or raw responses. `monthToDateSpend()` sums this ledger (anthropic
  rows) to enforce the monthly ceiling.
- **`scheduled_run_logs`** — scheduled-job run history.
- **`daily_briefings`** — one row per user per date (unique). Table exists; the app
  currently recomputes briefings per request and does **not** write here.

## Home / Today (read/rank view — no schema)

Home 1A (the default `/`) adds **no tables or columns**. It is a deterministic read-and-rank
view assembled by `lib/services/home.ts` (`buildHomeView`) over existing data only: `tasks`,
`obligations`, `financial_entries` (via `computeFinancialOutlook` + `listBills`),
`experiences` (+ `xpSummary`), and the owner's `users.name` (first token, for the greeting —
no new field). Prioritization is the pure `rankNeedsAttention` in `lib/briefing.ts` (overdue →
due-today → critical → due-soon → high, each with a visible reason). Experimental verticals
(signals/opportunities/jobs/interest) are excluded from Home. The full management workspace lives
at `/manage` (the relocated dashboard) and still covers every vertical.

## View models (UI contract)

The UI never depends on Drizzle row types. View models live in `lib/types.ts`
(`TaskView`, `ObligationView`, `FinancialOutlook`, `AccountView` (Finance 1A.1: +institution,
purpose, balanceSource, includeInSpendable, active, isCash, isLiability), `CashSummary`,
`BillView` (+sourceAccountId, paidAccountId, and Finance 1A.3A: actualAmount, paidAt),
`MovementView` (1A.3A; 1A.2 adds incomeId/incomeSource/transferId; 1A.3B adds priorBalance/newBalance),
`IncomeView` (1A.2: +status/actualAmount/receivedAt/destinationAccountId/allocations; 1A.4:
+scheduleId/estimateType/expectedMin/expectedMax/variance/variancePct), `IncomeScheduleView` (1A.4),
`AllocationView`
+ `TransferView` (1A.2), `AccountView.lastReconciledAt` + the projection read-models `FinanceProjection`
/ `AccountProjection` / `ForecastItem` / `ProjectionWarning` (1A.3B), `SignalView`, `OpportunityView`,
`JobView`, `InterestItemView`,
`ExperienceRequestView`, `ExperienceView`, `ExperienceXpSummary`, `Briefing`,
`DashboardData`). Service-layer `to*Views()` functions map rows → view models.
