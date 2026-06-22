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
`importance`, `bill_status`, `signal_type`, `signal_status`, `opportunity_category`,
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
- **`obligations`** — `title`, `type`, `startDate`, `endDate`, `startTime`, `location`,
  `description`, `importance`, `reminderDate`, `status`, `source`, `externalCalendarId`
  (reserved for future calendar sync, unused).

### Finances
- **`financial_accounts`** — `name`, `type`, `currentBalance` (manual; no bank link),
  `balanceUpdatedAt`, `notes`.
- **`recurring_bills`** — template: `name`, `expectedAmount`, `minimumPayment`,
  `dueDayOfMonth`, `recurrence`, `active`. **No instance generation implemented yet.**
- **`financial_entries`** — concrete bills/income instances; `kind` = `bill | income`,
  optional `recurringBillId`, `dueDate`, `expectedAmount`, `actualAmount`, `status`,
  `paidAt`. (Finance services use `kind = "bill"` rows for bills.)
- **`income_entries`** — `source`, `expectedAmount`, `actualAmount`, `payDate`,
  `recurrence`, `isPayday`.

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
  `status` (`draft` → `interpreted` → `planned`), and **Build 2A provenance**:
  `interpretationSource` (`experience_interpretation_source`: `manual` | `ai`, default
  `manual`), `interpretationProvider` (e.g. `anthropic`), `interpretationModel` (the exact
  model id used). Editing any AI-filled constraint resets `interpretationSource` to `manual`
  and clears provider/model; editing only `requestText` does not.
- **`experiences`** — a planned/resolved experience: required `requestId` FK, `title`,
  `description`, `plannedDate`, `plannedTimeText`, `locationText`, `expectedCost`,
  `actualCost`, `expectedDurationMinutes`, `physicalDifficulty`, `desiredFeeling`, `notes`,
  `status` (`planned` → `completed`/`cancelled`/`not_completed`, one-way), `completedAt`,
  `resolvedAt`, `nonCompletionReason`, `rating` (1–5), `reflection`, `meaningfulExperience`
  (owner-controlled bool), `adventureXp` (server-computed: 10 / 15 / 0). A partial unique
  index on `request_id` (where `deleted_at is null`) enforces one live experience per request.

**Request lifecycle transitions:**
- `draft → interpreted` when owner-triggered AI interpretation succeeds and writes
  constraints (Build 2A). A re-interpretation of an `interpreted` request stays `interpreted`.
- `draft`/`interpreted → planned` when a plan (experience) is created from the request.
- `planned → draft` when its live **planned** experience is soft-deleted (recovery, so the
  request is re-plannable). All constraint data is preserved. (Recovery returns to `draft`,
  not `interpreted`, even if it had been AI-interpreted — provenance fields are retained.)
- Soft-deleting an **already-resolved** experience does **not** reopen the request (stays
  `planned`). See `docs/DECISIONS.md` ADR-010.

### Intelligence / operations (reserved; no UI/logic yet)
- **`intelligence_settings`** — one row per user; `aiAutomationEnabled`, `killSwitch`,
  daily/monthly call & search limits, monthly cost limit, `lastSuccessfulRun`. The master
  gate for AI/automation — **now read by the Build 2A interpretation orchestration**
  (`lib/services/ai-experience.ts`) alongside the `AI_AUTOMATION_ENABLED` env flag and an
  `ANTHROPIC_API_KEY`. No settings UI yet (edited directly in the DB).
- **`api_usage_logs`** — provider/operation/token/cost ledger. Build 2A **writes** one bounded
  row per interpretation attempt (success or failure): provider, operation, token counts,
  estimated cost, success flag, and an error *category* — never prompts, request text, or raw
  responses. `monthToDateSpend()` sums this ledger to enforce the monthly ceiling.
- **`scheduled_run_logs`** — scheduled-job run history.
- **`daily_briefings`** — one row per user per date (unique). Table exists; the app
  currently recomputes briefings per request and does **not** write here.

## View models (UI contract)

The UI never depends on Drizzle row types. View models live in `lib/types.ts`
(`TaskView`, `ObligationView`, `FinancialOutlook`, `AccountView`, `BillView`,
`IncomeView`, `SignalView`, `OpportunityView`, `JobView`, `InterestItemView`,
`ExperienceRequestView`, `ExperienceView`, `ExperienceXpSummary`, `Briefing`,
`DashboardData`). Service-layer `to*Views()` functions map rows → view models.
