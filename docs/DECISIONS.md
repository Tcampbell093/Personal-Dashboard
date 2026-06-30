# Decision Log

> A running log of consequential choices. **Classification matters more than the entry.**
> Do not describe an inferred code choice as owner-approved without explicit evidence.

## Classifications

- **Owner-approved decision** — explicitly chosen by the owner; there is evidence. Durable.
- **Provisional implementation choice** — chosen by the implementer to get something working;
  reversible; not separately approved.
- **Current constraint** — a limitation of the current implementation, not a deliberate
  product stance.
- **Observed pattern** — a convention that is consistent in the code but was never formally
  decided.

> The entries below were **recorded retroactively from the existing codebase and git
> history** on 2026-06-21. With one exception (ADR-007) they are *not* owner-approved
> decisions; they are classified accordingly so the documentation does not overstate them.
> The durable product principles that govern AI behavior, privacy, and publishing live in
> `docs/PRODUCT_VISION.md` (owner-approved) — not here.

---

### ADR-001 — Stack: Next.js (App Router) + Neon Postgres + Drizzle
- **Classification:** Provisional implementation choice
- **Detail:** Next.js 15 + TypeScript on Netlify; Neon serverless Postgres (HTTP driver);
  Drizzle ORM with committed SQL migrations.
- **Evidence/rationale:** Present in the repo from the initial scaffold; README documents the
  rationale. No explicit owner approval of the stack is on record.

### ADR-002 — Layered architecture with view models
- **Classification:** Observed pattern
- **Detail:** UI → service layer → DB; services map rows → `lib/types.ts` view models; UI
  never queries the DB directly.
- **Evidence:** Consistent across all services/components; never separately decided.

### ADR-003 — Soft deletes only
- **Classification:** Observed pattern
- **Detail:** Domain rows set `deletedAt`; queries filter `isNull(deletedAt)`; no hard deletes
  in app code.
- **Evidence:** Uniform in `db/schema.ts` and every service.

### ADR-004 — Mock-data fallback
- **Classification:** Provisional implementation choice
- **Detail:** When the DB is unconfigured or a query fails, the dashboard renders mock data
  and shows a banner; each vertical exposes a `*Live` flag.
- **Evidence:** Implemented in `lib/services/dashboard.ts`. A scaffolding convenience; likely
  revisited once the app is always DB-backed.

### ADR-005 — Single hard-coded owner
- **Classification:** Current constraint
- **Detail:** All data belongs to `CURRENT_USER_ID = 1` (`lib/auth.ts`). The schema is
  multi-user-ready, but the app is single-user.
- **Note:** Whether real multi-user is ever in scope is a `[DECISION NEEDED]` deferred per
  `PRODUCT_VISION.md` (family/multi-user is a future possibility, not current scope).

### ADR-006 — "Vertical wiring" pattern
- **Classification:** Observed pattern
- **Detail:** Each data-backed feature follows service → API → client island → dashboard
  (see `docs/DESIGN_PRINCIPLES.md`).
- **Evidence:** Repeated identically across all seven verticals.

### ADR-007 — Authentication: single-owner password gate
- **Classification:** Owner-approved decision
- **Detail:** Protect the whole app behind one shared password (`APP_PASSWORD`) via a signed
  JWT cookie (`jose`) and `middleware.ts`; active only when configured. This is a single-owner
  gate, **not** account-based or multi-user auth.
- **Evidence:** The owner explicitly selected the "password gate" approach over OAuth and
  account-based options when asked. Real per-user auth was deliberately deferred.

### ADR-008 — AI / automation disabled
- **Classification:** Current constraint (governed by an owner-approved principle)
- **Detail:** AI and scheduled automation are off; gated by `intelligence_settings` (kill
  switch) and an env flag; the scheduled Netlify function is disabled.
- **Relation to principle:** The *implementation* being disabled is a current constraint. The
  *rule* that AI must not auto-publish/spend/contact/expose is an **owner-approved principle**
  recorded in `docs/PRODUCT_VISION.md`, not an inferred code choice.

### ADR-009 — Duplicate-plan guard: service check + partial unique index
- **Classification:** Provisional implementation choice
- **Detail:** Build 1 prevents two live experiences per request both at the service layer
  (reject when the request is already `planned`) and with a Postgres partial unique index on
  `experiences.request_id` where `deleted_at is null`. The request advances to `planned` only
  after the experience write succeeds.
- **Evidence/rationale:** The approved plan called for "duplicate-safe" plan creation; the
  partial unique index was added as a DB-level backstop against races. Reversible.

### ADR-010 — Experience request recovery on planned-experience deletion
- **Classification:** Provisional implementation choice
- **Detail:** When a **planned** experience is soft-deleted, its request is returned to
  `draft` so it is usable (re-plannable) again. Deleting an **already-resolved** experience
  does **not** reactivate the request (its status stays `planned`) — removing a history
  record must not produce a misleading active draft. Ownership-scoped.
- **Evidence/rationale:** Owner-requested lifecycle-integrity fix. The owner's preferred
  richer recovery (return to `recommendations_ready` when valid recommendations exist, else
  `interpreted`) is **deferred** because those lifecycle states and the recommendations
  column do not exist in Build 1; `draft` is the only consistent in-scope target. Revisit
  when those states/columns are introduced (Build 2/4).

### ADR-011 — First AI-assist capability: owner-triggered Experience interpretation (Build 2A)
- **Classification:** Owner-approved decision
- **Detail:** The first AI feature is interpretation only: turning an Experience request's
  free text into structured constraints, on explicit owner action ("Help me plan this"),
  using Anthropic Haiku (`claude-haiku-4-5` by default). It never publishes, spends, contacts
  anyone, or runs on a schedule; the manual path always remains usable, and AI is **off by
  default** behind three independent gates (env `AI_AUTOMATION_ENABLED`, an `ANTHROPIC_API_KEY`,
  and `intelligence_settings.aiAutomationEnabled`/`killSwitch`).
- **Data minimization (owner-specified):** interpretation sends only the request text, the
  general home area, and the current date — never finances, obligations, jobs, reflections,
  non-completion reasons, credentials, the full profile, or other experience history. Prompts,
  request text, and raw responses are **never logged**; only bounded metadata is.
- **Evidence:** The owner authorized the Build 2A scope in `HANDOFF.md` and supplied the
  privacy/data-boundary, default-off, and "do not make a live call / do not request my key"
  constraints verbatim. Implemented and **deterministically verified without a live key**;
  no live Anthropic invocation has been made in this environment.

### ADR-012 — Injectable provider boundary; deterministic fake is non-production
- **Classification:** Provisional implementation choice
- **Detail:** AI access goes through an `ExperienceAiProvider` interface. The only production
  resolver (`resolveProvider()`) reads the server env and returns the Anthropic adapter, or
  throws `ai_unavailable` when unconfigured. A deterministic `FakeProvider` exists for tests
  and is reachable **only** by server-side argument injection from the verification harness —
  never via any client-supplied request body, query, header, or cookie, and never from the
  factory. The adapter is the sole file importing the Anthropic SDK.
- **Evidence/rationale:** Lets the full gate/validation logic be verified offline (26/26
  deterministic checks) while satisfying the owner's hard isolation requirement that the fake
  must not be selectable in production by any client input. Reversible.

### ADR-013 — AI cost ceiling: $5/mo dev constant + per-op caps, reusing existing tables
- **Classification:** Provisional implementation choice
- **Detail:** Cost is bounded before any call by a per-operation cap (interpret $0.02) and a
  monthly ceiling = min($5 dev constant, configured `monthly_cost_limit`). Spend is summed
  from the existing `api_usage_logs` and gated via `intelligence_settings` — **no parallel
  cost store**. Breaches return `per_op_limit` (422) or `budget_exceeded` (429); the manual
  path still works.
- **Evidence/rationale:** The approved plan called for a hard, conservative ceiling reusing
  existing infrastructure. The specific dollar values are implementer-chosen and reversible.

### ADR-014 — Visual design direction: dark immersive "personal command center"
- **Classification:** Owner-approved decision (direction); specific token values, per-area hues,
  and artwork are **provisional** pending ratification or a dedicated visual-redesign task.
- **Detail:** The Personal Life OS adopts a dark, immersive, subtly gamified,
  personal-not-corporate visual language, inspired in *feel* by "Life OS Dashboard" but built as
  an **original** system (no copied branding, artwork, copy, or layouts). Two accent layers
  coexist: cross-cutting **urgency semantics** (act/aware/explore/good) and per-**life-area
  identity** hues, governed by a color-discipline rule (one dominant identity color per page; no
  rainbow-dashboard effect). Experiences uses a restrained cyan→violet exploration palette,
  distinct from the urgency colors. System fonts are retained (no remote fonts); a custom display
  face is deferred. Permitted artwork media are original pixel art, atmospheric illustration,
  abstract environmental artwork, and future subtle animated scenes — unified by coherent mood/
  palette, originality, performance, and accessibility. Full artwork/banners, navigation overhaul,
  motion-system implementation, and re-skinning **existing application areas and workflows** are
  deferred to a **separate application-wide visual redesign**. The full system is documented in
  `docs/DESIGN_SYSTEM.md`.
- **Evidence:** Owner explicitly set this direction as the visual north star ahead of Build 2B, as
  a documentation/design-system planning task (this entry), with implementation deferred. The
  current navigation structure is explicitly **not** treated as permanently fixed.
- **Relation to principles:** Serves PRODUCT_VISION 13a/13b; constrained by privacy cues
  (AI-vs-owner provenance must stay legible) and accessibility (WCAG AA).

### ADR-015 — AI recommendations (Build 2B.1): owner-triggered, whole-batch, clear-on-edit
- **Classification:** Owner-approved decision
- **Detail:** The second AI feature generates exactly **three** differentiated experience
  *concepts* via Anthropic Sonnet (`claude-sonnet-4-6`, env-configurable), on explicit owner
  action ("Find experiences" / regenerate "Find new options"). The batch is validated as a whole
  (`lib/ai/recommendation-schema.ts`) — any violation rejects the entire batch with no partial
  persistence — and stored on `experience_requests.recommendations` with provenance and status
  `recommendations_ready`. Regeneration **replaces** the batch (no history/versioning). Editing
  the request text **or** any interpreted constraint **clears** the batch and reverts to
  `interpreted` (no AI call), since the prior batch no longer matches. Recommendations are
  concepts, not verified facts: the model is instructed not to assert live hours/pricing/
  availability/weather/travel, and each card shows a verification note. Cost is gated before any
  call by a $0.05 per-op cap and the shared monthly ceiling; bounded usage metadata only is
  logged. **Build 2B.1 stops before selection** — "Choose this", Experience creation, and
  `selected_recommendation_id` are deferred to the separately-gated Build 2B.2.
- **Evidence:** Owner authorized the Build 2B.1 scope and decisions in `HANDOFF.md`. Implemented
  and **deterministically verified without a live key** (`scripts/verify-build2b1.ts`, 113/113);
  no live Anthropic invocation has been made.

### ADR-016 — Application-assigned opaque recommendation ids
- **Classification:** Provisional implementation choice (owner-directed)
- **Detail:** The model never provides or controls recommendation ids. After the whole batch
  passes validation, the application assigns each item a globally-unique opaque id `rec_<uuid>`
  (`crypto.randomUUID`). Ids are unique within and across batches; regeneration mints new ids;
  ids from a replaced/cleared batch no longer exist in storage and are therefore not selectable.
  (Selection-time resolution against the current stored batch is implemented in Build 2B.2.)
- **Evidence/rationale:** Owner-directed (replaces model-supplied-id trust + duplicate-id
  validation). Prevents a stale or model-chosen id from being trusted. Reversible.

### ADR-017 — One-action plan creation via a single atomic writable-CTE
- **Classification:** Owner-approved decision
- **Detail:** Choosing a recommendation (Build 2B.2) creates the planned experience in **one**
  SQL statement — a writable CTE (`UPDATE experience_requests … RETURNING` feeding
  `INSERT INTO experiences … SELECT … FROM that`) executed via the Neon HTTP driver. The single
  statement is implicitly atomic, so the request transition and the experience insert persist
  **both or neither**. The `UPDATE … WHERE` enforces, in one boundary, owner scoping, not-deleted,
  status `recommendations_ready`, and that the recommendation id is still present in the **current**
  stored batch (`recommendations @> [{"id":…}]::jsonb`) — guarding against regeneration/clear-on-edit
  between the pre-read and the write. The partial unique index `experiences_request_live_uq` remains
  the duplicate backstop; a unique violation maps to 409, a zero-row result is disambiguated (404
  stale/unknown vs 409 status-changed) via a follow-up read. The request body accepts **only**
  `{recommendationId}` (extra fields → 422); every authoritative value is resolved server-side from
  the stored batch. Verified compatible on the actual Neon HTTP driver.
- **Evidence:** Owner directed the atomic single-statement approach (with a "stop and report"
  guard against silently using a non-atomic fallback). Compatibility confirmed; no fallback used.

### ADR-018 — Planned-experience deletion recovery (supersedes ADR-010's deferral)
- **Classification:** Owner-approved decision
- **Detail:** Soft-deleting a `planned` experience returns its request to `recommendations_ready`
  when the deleted plan's `selected_recommendation_id` is still in the request's current batch;
  otherwise (manual plan / batch since changed) to `draft` (the Build 1 behavior preserved as the
  fallback). The batch is never cleared, no AI call is made, no plan is auto-created, and a
  resolved experience's deletion never reactivates the request. This implements the richer recovery
  ADR-010 explicitly deferred until the recommendation states/columns existed.
- **Evidence:** Owner-specified in the Build 2B.2 authorization.

### ADR-019 — Home / Today as the default page; deterministic-first; dashboard → /manage
- **Classification:** Owner-approved decision
- **Detail:** The default route `/` is now the **Home / Today** command center — a curated,
  mostly-read-only daily view (Today, Needs attention, Coming up, Money awareness, Life momentum)
  built **only** from real verticals (tasks, obligations, finances, experiences/XP, `users.name`).
  Prioritization is **deterministic and explainable** (`rankNeedsAttention` in `lib/briefing.ts`;
  every item shows a visible reason) — **no AI**. The former full dashboard was **relocated
  verbatim** to **`/manage`** via a single shared `components/manage/manage-dashboard.tsx` (no
  duplicate page). Two direct actions only (complete a task, mark a bill paid) reuse existing
  islands; sections degrade independently, with a full-page error reserved for core/DB failure
  (never mock fallback). **Experimental/sample-backed verticals (signals, opportunities, jobs,
  interest) are excluded from Home** and honestly labeled on `/manage`. Money shows only
  `FinancialOutlook`-supported figures with the wording "Estimated remaining from manually entered
  balances" — never safe-to-spend/disposable/available/live-balance. No new schema or migration.
- **Home identity:** warm champagne `#e8c878` (per `docs/DESIGN_SYSTEM.md`).
- **Evidence:** Owner approved the Home 1A plan with these decisions/corrections. **Home 1B**
  (an owner-triggered AI daily brief) remains **separately gated** and is not implemented.

### ADR-020 — Manage clarity (Act Today vs Upcoming Commitments) + task-completion history
- **Classification:** Owner-approved decision
- **Detail:** `/manage` separates **Act Today** (actionable tasks; explicit due/overdue labels;
  complete action) from **Upcoming Commitments** (dated obligations; "not checklist tasks"; their
  own done/cancel) — distinguished by wording, subtitles, metadata, and action labels, never color
  alone. Tasks and obligations are treated as **distinct object types** and never presented as
  interchangeable. **Task completion is non-destructive and recoverable:** completing sets
  `status='completed'` + `completedAt` (no hard delete), shows a confirmation + short-lived
  **Undo**, removes the task from the active list, and lists it under a **collapsed "Recently
  completed"** section with a **Reopen** action that restores it to active and clears `completedAt`.
  Home shows a small truthful "N tasks completed today" signal only; the full archive stays on
  `/manage`. **No schema change** — the `tasks.completedAt` column already existed (no migration).
- **Evidence:** Owner-approved bounded "Manage clarity and task-history" task. No AI, no decorative
  game features.

### ADR-021 — Finance 1A.1: account-aware manual finance (accounts + bills), no balance mutation
- **Classification:** Owner-approved decision (owner approved the Finance 1A.1 scope, with explicit
  owner decisions on each point below)
- **Detail:** First of three gated Finance 1A sub-builds. **Accounts** gain `institution`, a
  validated `type` and `purpose`, `balanceSource` (`manual`|`linked`), `includeInSpendable`, and
  `active`. **Bills** gain nullable `sourceAccountId` + `paidAccountId`. A dedicated **`/finances`**
  page (emerald Money identity) shows **manually entered actual balances** with truthful rollups
  (total actual cash / spendable / savings-emergency / credit liabilities) and bills grouped by
  payment account. Owner-decided rules locked in:
  - **No balance mutation in 1A.1.** Marking a bill paid records status + `paidAt` + `paidAccountId`
    only; actual balances stay manually entered. (Recorded movements that move balances on
    pay/receive/transfer are deferred to **1A.3**.)
  - **Credit is a liability, never cash.** A credit account's balance is the amount **owed** (stored
    positive); it is shown separately and excluded from every cash total. `netPosition = cash −
    credit owed`.
  - **Cash definitions:** total actual cash = active cash-type accounts (incl. savings); spendable =
    the `includeInSpendable` subset (savings/emergency default excluded); never one total that adds
    credit-card debt as available money.
  - **Credit-never-spendable is a hard data invariant**, enforced server-side on **both POST and
    PATCH**: whenever the resulting stored type is credit, `includeInSpendable` is persisted `false`
    (any client attempt to set it true is overridden); switching a credit account to a non-credit
    type never auto-enables spendable (the existing value is preserved unless the owner explicitly
    sets it). No stored credit account can ever have `includeInSpendable=true`.
  - **Provider scope correction:** no `providerAccountId` / `syncStatus` / `connectionError` /
    `lastSyncedAt` on the account — only the provider-neutral `balanceSource`. A future
    bank-connection model (`financial_connections`, Finance 1B) owns connection health.
  - **Reconciliation scope correction:** no `lastReconciledAt` and no reconcile workflow (Finance
    1A.3 owns reconciliation + its audit adjustment).
  - **Legacy `estimatedRemaining`** is kept only as a temporary compatibility figure (wording
    unchanged) but corrected so it never counts credit or inactive accounts as cash; Finance 1A.3
    replaces it with account-aware projection.
  - **Recorded future decisions:** movement-backed balance updates (1A.3); fixed → percent-of-
    remaining → remainder **income splits** (1A.2); **transfers** scheduled + completed (1A.2);
    separate bank-connection model (1B).
  - **Enum vs validated-string:** `balance_source` is a **pgEnum** (closed, behavior-gating binary).
    `type` and `purpose` are **validated varchars** (server-enforced against fixed lists) so the
    owner can extend the vocabularies later without a type migration.
  - **Migration:** additive only (`0005_concerned_colossus.sql` — `CREATE TYPE` + `ADD COLUMN` + FK
    `ADD CONSTRAINT`); reviewed for destructive ops before applying; existing accounts/bills
    preserved with truthful defaults (`purpose='other'`, `balanceSource='manual'`,
    `includeInSpendable=true`, `active=true`, bill account links null).
- **Evidence:** `scripts/verify-finance1a.ts` (74/74, real services + routes vs real Neon) + browser
  (desktop + 375px), including DB-confirmed "Chase balance unchanged after a paid-from-Chase bill"
  and owner-data preservation. No AI / no usage log. Build 1 / 2A / 2B.1 / 2B.2 / Home 1A /
  Manage-tasks regress green.

### ADR-022 — Finance 1A.3A: manual bill-payment ledger (atomic, append-only, idempotent)
- **Classification:** Owner-approved decision (owner approved the Finance 1A.3A scope and behavior).
- **Detail:** Paying a bill is now a balance-changing, ledgered action — but only for **manual**
  accounts and only for bill payments (this sub-build deliberately excludes income, transfers,
  discretionary spending, reconciliation, projection, Plaid, and AI).
  - **New `account_movements` table** (append-only; no `updatedAt`/`deletedAt`) records every change
    a recorded payment makes to a manual balance: a `bill_payment` is negative, its
    `bill_payment_reversal` is the equal positive entry, linked by `reversal_of_id`.
  - **Atomicity:** pay = one writable-CTE statement that flips the bill to paid, deducts the account,
    and inserts the movement all-or-nothing; reverse = one statement that reopens the bill, credits
    the account, and inserts the reversal. (Same Neon-HTTP single-statement pattern as ADR-017.)
  - **Idempotency / concurrency:** the bill-status guard (`WHERE status IN open-set` for pay,
    `WHERE status='paid'` for reverse) makes a duplicate/concurrent call a no-op (→ 409); a **partial
    unique index on `reversal_of_id`** backstops concurrent reversals so a payment can be credited
    back at most once. Verified with real wall-clock `Promise.allSettled` races.
  - **Confirmed actual amount:** the owner confirms the amount actually paid (defaulting to expected);
    that amount is what is deducted and recorded, and is stored on the bill (`actual_amount`).
  - **External/cash + linked:** an external/cash payment (no account) marks the bill paid and changes
    no balance / writes no movement; a `linked` account is marked paid but **never** receives a manual
    deduction (no movement) — only its future bank sync may change it.
  - **Reversal reopen:** reversing reopens the bill to `scheduled`/`due`/`overdue` by its due date
    (local timezone) and clears `paid_at`/`paid_account_id`/`actual_amount`; the original payment
    movement is **never deleted**.
  - **No back-fill:** the ledger starts empty; **existing/historical paid bills get no fabricated
    movement**, and reversing a pre-ledger paid bill simply reopens it with no credit.
  - **Supersedes** ADR-021's "marking paid never changes a balance" **for manual-account payments**
    (external/linked still change nothing). The legacy `estimatedRemaining` is unchanged.
  - **Lifecycle ownership:** paying/reopening go through dedicated `POST .../pay` and `.../reverse`
    endpoints (and `PATCH status:"paid"` as the Home quick-action compatibility path); bill PATCH no
    longer performs balance-less status flips or standalone `paidAccountId` edits, so the ledger can't
    be bypassed.
- **Evidence:** `scripts/verify-finance1a3a.ts` (67/67, real route handlers + services vs real Neon,
  incl. concurrency) + authenticated end-to-end HTTP through the running server (login → pay →
  duplicate-pay 409 → reverse → duplicate-reverse 409, SSR HTML confirmed). No AI / no usage log.
  Finance 1A.1 / Home 1A / Manage-tasks / Build 2A / 2B.1 / 2B.2 regress green.

### ADR-023 — Finance 1A.2: income splits + account transfers (ledger-backed, reversible)
- **Classification:** Owner-approved decision (owner approved the Finance 1A.2 scope and behavior).
- **Detail:** Extends the 1A.3A account-movements ledger to income receipt and account transfers,
  reusing its atomicity/idempotency machinery. Scope deliberately excludes Plaid, bank sync, imported
  transactions, discretionary spending, recurring-bill generation, reconciliation, projection, and AI.
  - **Split-order rule:** fixed → percent **of the amount remaining after fixed** → one optional
    remainder. Computed in **integer cents** (no float drift); shares always sum exactly to gross —
    the remainder row (or, without one, the last share) absorbs the deterministic rounding. Validation:
    at most one remainder; percent total ≤ 100; no duplicate destination (`unique(incomeId, accountId)`);
    fixed ≤ gross (at receipt); without a remainder, percents must total exactly 100% (or fixed-only
    must equal gross). The same pure function (`lib/finance-allocations`) powers the client preview and
    the server receipt.
  - **Income receipt/reversal lifecycle:** `scheduled` income changes no balance. Receiving resolves
    the destination (single or split) against the confirmed gross and, in ONE writable-CTE statement,
    marks it received + credits each **manual** destination + writes one positive `income_received`
    movement (guarded by `status='scheduled'`). Undo appends equal negative `income_reversal` movements
    and restores balances, guarded by `status='received'` + the `reversal_of_id` unique index.
  - **Transfer completion/reversal lifecycle:** scheduled transfers change no balance. manual→manual
    completion atomically deducts source, credits destination, writes paired `transfer_out`/`transfer_in`
    movements; reversal appends opposite movements and restores both. **Total owned cash is invariant.**
  - **Linked-account limitation (smallest truthful model):** linked destinations/accounts are never
    manually mutated. Income to a linked destination is marked received with no movement. manual→linked
    transfer deducts the source only (destination is bank-authoritative); **linked-source completion is
    rejected** rather than fabricating a deduction of an externally-authoritative balance. Credit
    accounts are rejected as income/transfer endpoints (they're liabilities, not cash).
  - **Scheduled-vs-actual:** only received income and completed transfers change manual actual
    balances; scheduled allocations/transfers are never presented as "projected cash" (no projection
    engine exists yet).
  - **Concurrency:** single-statement writable CTEs on Neon HTTP; bill/income/transfer-status guards
    + row locking serialise racers (loser → 409); the `reversal_of_id` unique index backstops
    concurrent reversals. Verified with real wall-clock `Promise.allSettled` races.
  - **Existing data:** the ledger/allocation/transfer tables start empty; **no historical income gets
    a fabricated allocation or movement**; income without a destination stays valid as "Destination not
    assigned". Migration `0007_square_marauders.sql` is additive only.
  - **UI move:** income management moved from `/manage` to `/finances`; `/manage` Money is now a summary
    + link (verified before the move). Recent activity labels all bill/income/transfer movements and
    never shows transfers as earnings or spending.
  - **Future:** matching these manual movements against imported bank transactions is reserved for a
    later Finance 1B (read-only bank connections).
- **Evidence:** `scripts/verify-finance1a2.ts` (62/62, real routes + services vs real Neon, incl.
  concurrency) + authenticated end-to-end HTTP through the running server (split receive/undo +
  scheduled→complete→reverse transfer, SSR HTML confirmed). No AI / no usage log. Finance 1A.1 / 1A.3A
  / Home 1A / Manage-tasks / Build 2A / 2B.1 / 2B.2 regress green.

### ADR-024 — Finance 1A.3B: reconciliation + deterministic projection (actual vs projected)
- **Classification:** Owner-approved decision (owner approved the Finance 1A.3B scope and behavior).
- **Detail:** Adds manual-account reconciliation and a separate, deterministic projection. Scope
  excludes Plaid, bank login, imported transactions, discretionary spending, recurring-bill
  materialization, credit-score/investments/tax, AI, and automatic money movement.
  - **Reconciliation model (smallest auditable):** kept in the one `account_movements` ledger — a
    `reconcile_adjustment` row carries the signed delta + `prior_balance`/`new_balance`;
    `financial_accounts.last_reconciled_at` records the verify time. No separate reconciliation table.
    Reconcile atomically sets the actual balance to the entered real balance, stamps the timestamp, and
    appends the adjustment (a **zero delta** only refreshes the timestamp — no meaningless movement).
    Manual accounts only (linked/inactive/foreign rejected); an **optimistic balance guard**
    (`current_balance = prior`) makes a duplicate/concurrent reconcile apply at most once. **Undo**
    (only the latest unreversed reconcile, and only while the balance is unchanged) restores
    `prior_balance`, re-derives `last_reconciled_at` from the remaining unreversed reconciles, and
    appends a `reconcile_reversal` (original never deleted; `reversal_of_id` unique index blocks
    double-undo). Never fabricates reconciliation for historical balance edits.
  - **Actual vs projected:** projection is a **pure read-model** (`lib/services/finance-projection.ts`),
    never writes the DB and never overwrites `currentBalance`. `projected = actual + scheduled inflows −
    scheduled outflows` within a horizon. A projected figure is never labeled current/live/available/
    safe-to-spend.
  - **No double-counting:** only SCHEDULED items project. Paid bills, received income, and
    completed/reversed transfers already live in the actual balance and are excluded. Internal
    manual↔manual transfers net to zero across owned cash.
  - **Unassigned + linked:** unassigned bills/income are surfaced (warnings) and never guessed into an
    account; linked-account scheduled items are excluded with a truthful "awaiting bank sync" warning;
    credit liabilities stay separate from cash; scheduled credit-card payments reduce the paying cash
    account, not a credit "available" figure.
  - **Horizons:** 7 days / until next payday / 30 days; default **until next payday** (deterministic
    14-day fallback when no future payday). The chosen horizon is visible and switchable.
  - **Warnings:** deterministic + self-explaining (projected shortfall / below $0, unassigned bill,
    income destination not assigned, transfer involving linked account) — no AI ranking or advice.
  - **Migration:** additive only (`0008_useful_vapor.sql` — `ALTER TYPE ADD VALUE` ×2 + 3 nullable
    `ADD COLUMN`; no rewrite/backfill/balance change).
  - **Future (recorded, not implemented):** linked-account balances will replace manual reconciliation;
    imported transactions will confirm bills/income/transfers; manual movements must not duplicate
    imported transactions; matching attaches evidence to scheduled records; uncertain matches require
    owner approval.
- **Evidence:** `scripts/verify-finance1a3b.ts` (46/46, reconciliation via real routes + services incl.
  concurrency; projection via the pure engine) + authenticated end-to-end HTTP (projection HTML across
  horizons, reconcile/undo, actual balances unchanged by projection). No AI / no usage log. Finance
  1A.1 / 1A.3A / 1A.2 / Home 1A / Manage-tasks / Build 2A / 2B.1 / 2B.2 regress green.

### ADR-025 — Finance 1A.4: recurring income schedules + estimate-vs-confirmed paychecks
- **Classification:** Owner-approved decision (owner approved the Finance 1A.4 scope and behavior).
- **Detail:** Adds recurring income with explicit estimate confidence. Scope excludes Plaid, bank
  login, imported transactions, payroll integration, automatic bank matching, discretionary spending,
  and AI.
  - **Schedule vs occurrence:** a new `income_schedules` table is the reusable rule; OCCURRENCES are
    materialized as `income_entries` rows (linked by `schedule_id`) so they reuse the existing
    receipt/reversal/split/projection machinery (no parallel receipt logic). `income_schedule_allocations`
    snapshots the schedule's split; copied into `income_allocations` per occurrence so edits never
    rewrite a received paycheck. (Chosen over overloading one row for both rule + every paycheck.)
  - **Recurrence rules:** one-time, weekly, biweekly, twice-monthly (two days; a day past month-end →
    last calendar day, leap-aware), monthly (incl. last day). Pure, UTC-anchored calendar math
    (`lib/finance-recurrence.ts`); the app timezone supplies "today".
  - **Estimate modes + range projection rule:** `fixed`/`typical` → expected; `range` → the **minimum**
    (conservative, documented); `unknown` → **$0** (payday shown, adds nothing). Estimated income is
    never treated as confirmed cash; every estimate is labeled; the UI never implies guaranteed,
    payroll-certain, or bank/employer-verified income.
  - **Occurrence generation:** materialized (not derived) into a bounded rolling −14…+90-day window;
    idempotent (existing-date check + a partial unique index on `(schedule_id, pay_date)`); replenished
    on `/finances` + Home load — **no background automation**.
  - **Receipt + variance:** reuses the income-receipt ledger (atomic, split-aware); stores actual gross
    + received date + variance (actual − expected, $ and %); reversible; duplicate/concurrent receipt
    blocked. Skip/cancel exclude an occurrence from projection; received/paid never double-counted.
  - **Schedule-edit rule + individual overrides (history-safety correction):** a field/split edit
    regenerates only FUTURE, still-`scheduled`, **non-overridden** occurrences; received/skipped/
    cancelled/reversed/past **and individually-edited** occurrences are preserved. Occurrence overrides
    are tracked by an **explicit `is_overridden` flag** (set on any occurrence-level edit — never
    inferred from value diffs), and a **`scheduled_for`** rule-date claim prevents a duplicate on the
    original or moved date. Editing one occurrence never touches the schedule or other occurrences.
  - **Archive vs hard-delete (history-safety correction):** removing a schedule that has ANY
    occurrence/history **archives** it (soft-delete + pause; all occurrences + ledger movements kept
    and readable; no new generation) — only a genuinely unused schedule is hard-deleted. The
    `income_entries.schedule_id` and `account_movements.income_id` FKs are **`ON DELETE no action`**, so
    the DB cannot cascade-delete income occurrences or ledger history; a hard-delete with history is
    rejected. Migration `0010_curvy_lily_hollister.sql` (additive: `scheduled_for` + `is_overridden`,
    no backfill).
  - **Next-payday wording:** `Until next expected payday` only when an active recurring payday
    occurrence is next; `Until next scheduled income` for one-time/non-payroll income; deterministic
    14-day fallback otherwise (no false "next payday").
  - **Migration:** additive only (`0009_loud_nightmare.sql`); existing income stays standalone — **no
    auto-conversion** of owner income into a schedule.
  - **Future bank-sync (recorded, not implemented):** imported deposits match expected occurrences,
    replace estimates with actuals, must not duplicate manual movements; uncertain matches need owner
    approval; recurring detection may suggest but never silently create a schedule.
- **Evidence:** `scripts/verify-finance1a4.ts` (65/65: recurrence dates, generation idempotency/bounds,
  estimate modes, receipt/split/reversal, statuses/warnings, forecast wording, **schedule-history
  safety (archive vs delete, FK no-cascade), individual-occurrence overrides**, safety) + authenticated
  end-to-end HTTP (schedules → occurrences → receive-with-variance → reverse → skip; Home wording). No
  AI / no usage log. Finance 1A.1 / 1A.3A / 1A.2 / 1A.3B / Home 1A / Manage-tasks / Build 2A/2B.1/2B.2
  regress green.

### ADR-026 — Official product name: Xanther
- **Classification:** Owner-approved decision (owner explicitly renamed the product to **Xanther**,
  spelled `X-A-N-T-H-E-R`).
- **Detail:**
  - **Official name:** the product is **Xanther**. Canonical definition: *Xanther is a private,
    AI-powered personal operating system and life-progression platform combining practical life
    management, financial awareness, planning, experience discovery, personal progression, memory, and
    an eventual conversational AI assistant.* `Xanther` names **both** the application/Life OS and the
    **future conversational assistant** that will operate through the app's permissioned tools — not
    merely a dashboard, command tool, or generic chatbot.
  - **Historical aliases only:** *Personal Command Center*, *Personal Command Tool*, *Command Tool*,
    *Personal Dashboard*.
  - **Technical identifiers unchanged:** routes, API endpoints, DB tables/columns, migrations,
    environment-variable names, internal service names, record identifiers, the GitHub repo name
    (`Personal-Dashboard`), and the Netlify project/deploy config are **deliberately not renamed** (not
    user-facing product identity; renaming risks breakage). **No schema migration** was created for the
    rename.
  - **Scope:** a bounded branding/identity change. It does **not** change the current roadmap,
    architecture, or approved functionality. The future conversational layer will **operate over the
    existing workflows rather than replace them**, and is documented (ROADMAP) but **not implemented**
    (no voice/speech libraries, dependencies, AI calls, chat UI, or data models were added).
- **Evidence:** user message renaming the product to Xanther (this task). User-facing surfaces updated
  (browser title, login wordmark, README, PRODUCT_VISION, ROADMAP, DESIGN_SYSTEM); typecheck + build +
  full regression suite green; secret scan clean; routes/schema/APIs/deps/env unchanged.

### ADR-027 — Finance 1B.0: bank-integration security & provider foundation
- **Classification:** Owner-approved decision (owner approved the Finance 1B plan + the 1B.0 scope and
  first-version defaults).
- **Detail:** Establishes the internal contracts + security model **before any bank connection exists**.
  Finance 1B is **read-only and moves no money**. This build adds **no** Plaid SDK, provider call,
  link route, stored token, table, or migration.
  - **Provider = Plaid (initial); domain stays provider-neutral.** The finance domain depends only on
    `lib/providers/bank-provider.ts` (`BankProvider`) + DTOs in `lib/providers/types.ts`; a future Plaid
    adapter maps raw responses behind that boundary. No multi-provider registry.
  - **Sandbox-first.** Production/OAuth onboarding is a later owner step. Real Chase/BofA need eligible
    Production access (the standalone Development environment was decommissioned 2024-06-20; Limited
    Production blocks OAuth for Chase/BofA/Wells Fargo and is replaced by Trial plans for teams created
    after 2026-04-15).
  - **Cached balances only** — no paid real-time refresh in the initial version; balances carry an
    `asOf` and the UI shows a truthful "last updated".
  - **Canonical sign convention** (`lib/providers/amount.ts`): inflow **positive**, outflow
    **negative**, **zero invalid**. Adapters normalize provider-native amounts before returning DTOs; no
    provider-native sign leaks into matching/UI.
  - **Balance authority** (`lib/providers/balance-authority.ts`, pure): manual ← `currentBalance`;
    linked ← latest provider snapshot (provider-authoritative, with `asOf`); stale/disconnected exposes
    last-known **only when labeled stale**; a missing linked balance resolves to **`linked_unavailable`
    (null)** and **never** falls back to the manual balance; projections consume but never overwrite it.
  - **Imported evidence vs command ledger:** `account_movements` stays manual-command history; linked
    imported transactions are **evidence** and create **no** balance movement.
  - **Token encryption** (`lib/providers/token-crypto.ts`): **AES-256-GCM** (Node `crypto` only), random
    96-bit nonce per encryption, versioned envelope `{v, keyVersion, nonce, ciphertext, tag}`, 256-bit
    master key from **secure random bytes** supplied via `BANK_TOKEN_ENC_KEY` **read lazily** (never at
    import). **Server-only:** a runtime `typeof window` guard fails closed in any browser bundle (no new
    dependency), and a transitive import scan proves no Client Component reaches the module. **Fail
    closed:** strict base64 → exactly-32-byte key (else reject); unsupported version, missing
    nonce/ciphertext/tag/keyVersion, tampered ciphertext/tag, and wrong key each throw; no error message
    leaks plaintext/ciphertext/token/key. **Hashing is explicitly not used** (token must be recoverable).
    **No real credential created/stored** — fake test strings.
  - **Durable pending-sync trigger (planned, not built):** a verified webhook records a durable
    pending-sync row in Neon (duplicates collapse per connection); a bounded processor paginates
    `/transactions/sync`; the cursor advances **only after successful persistence** (prior cursor
    preserved on error); the webhook does **no** unbounded multipage sync. No imaginary queue/worker.
  - **Env-var contract (names only, not required at runtime yet):** `PLAID_CLIENT_ID`, `PLAID_SECRET`,
    `PLAID_ENV`, `BANK_TOKEN_ENC_KEY`, `PLAID_WEBHOOK_URL`, `PLAID_REDIRECT_URI` — none `NEXT_PUBLIC_`;
    Sandbox/Production secrets separate; redacted in logs.
- **Evidence:** `scripts/verify-finance1b0.ts` (52/52: provider-neutral contracts, sign normalization,
  balance authority incl. no-manual-fallback, durable-sync design, AES-256-GCM round-trip + tamper
  rejection, server-only import-boundary scan + fail-closed envelope/key-decoder invariants, no Plaid
  dep/route/table/migration/credential, no NEXT_PUBLIC bank var, Finance 1A.4 + owner data + request 222
  intact) + typecheck + build + all regressions green + secret scan clean. Full reference:
  `docs/BANK_INTEGRATION_SECURITY.md`.

### ADR-029 — Finance 1B.2: Plaid Sandbox accounts + cached balances
- **Classification:** Owner-approved decision (owner approved the 1B.2 scope).
- **Detail:** Discover Plaid **Sandbox** accounts for an existing connection, store **cached** balances +
  freshness, and let the owner create a **NEW linked Xanther account** from an unmapped provider account.
  Read-only; **no money movement, no transactions, no webhooks, no matching.**
  - **`provider_accounts` model (single table, NOT a separate mappings table):** chosen because the
    provider↔Xanther link is a strict 1:1 — a separate `provider_account_mappings` table would duplicate
    the same relationship. `financial_account_id` (nullable) holds the link; unique
    `(connection_id, provider_account_id)` scopes provider identity; a partial unique index on
    `financial_account_id` enforces one Xanther account per provider account. Cached balances +
    `balance_as_of` live here (NOT copied into an editable field). No token, cursor, imported
    transactions, or raw Plaid payload stored. Additive migration `0012_loud_barracuda.sql`.
  - **Adapter:** `listAccounts` + `getCachedBalances` via Plaid `/accounts/get` (cached, free). **No
    paid `/accounts/balance/get`.** Raw Plaid types stay in `lib/providers/plaid/`. Account-type
    normalization (Plaid-specific, in the adapter): depository+checking→checking, depository+savings→
    savings, credit→credit, else→other. **Credit sign:** Plaid `current` is the positive amount owed,
    matching Xanther's existing liability convention (stored unflipped, excluded from cash/spendable).
  - **Balance authority:** a linked account's `financial_accounts.currentBalance` is **NULL** (never an
    editable competing source); its authoritative balance is resolved from the provider snapshot via the
    1B.0 resolver. A **missing** snapshot → `Balance unavailable` (never a fallback to manual/zero) and
    excluded from totals with a warning; **stale** → labeled "last known"; cached balances are labeled
    truthfully (never "live"/"real-time"). Linked accounts cannot be reconciled or have their balance
    manually edited (the service strips balance/source edits; reconcile already rejects linked).
  - **Existing-manual mapping is DEFERRED** (a later phase): mapping a provider account onto an existing
    manual account needs final reconciliation, a transition timestamp, movement preservation, duplicate
    safeguards, rollback rules, and explicit authority-handoff confirmation. 1B.2 only creates a NEW
    linked account; Chase/BofA are never merged, renamed, or converted.
  - **Sync lifecycle:** idempotent upsert by `(connectionId, providerAccountId)`; previously-seen
    accounts now missing → `stale` (retained, never deleted); `lastSyncAttemptedAt` always updated,
    `lastSyncedAt` only on success. Decryption failure writes no account data; a provider failure
    preserves prior rows + prior `lastSyncedAt`. Linked-account creation is insert-then-claim
    (guarded `WHERE financial_account_id IS NULL` UPDATE; orphan rolled back) → a duplicate/concurrent
    call yields exactly one account.
  - **Routes:** `POST /api/finances/connections/[id]/accounts/sync`, `GET …/accounts`,
    `POST /api/finances/provider-accounts/[id]/create-linked-account`. The owner, provider ids, balance,
    and balance source are never trusted from the request body.
  - **Orphan prevention (lifecycle-safety correction):** a connection (or provider-account record) may
    **never** be hard-deleted while any provider account is linked to a Xanther account — that would
    leave a `balanceSource='linked'` account with no provider authority. **Defense in depth:** (1) the
    `provider_accounts.connection_id` FK was changed from `ON DELETE cascade` to **`NO ACTION`**
    (migration `0013_next_speed.sql`, constraint-only) so the DB itself resists deleting a connection
    that still has provider-account rows; (2) `deleteConnection` rejects a connection with any mapped
    provider account with a bounded **409** (`This connection has linked Xanther accounts and cannot be
    removed yet.`) mutating nothing, and otherwise deletes the **unmapped** provider snapshots + the
    connection in a single race-safe guarded CTE (a concurrent create-linked makes the connection
    DELETE violate the FK and abort — no orphan); (3) the Sandbox cleanup helper tears down in a safe
    order (clear mapping → delete the `linked` account → delete the provider row) and never touches a
    manual account. Full disconnect/archive/token-revocation lifecycle remains a later (1B.9) concern.
- **Evidence:** `scripts/verify-finance1b2.ts` (69/69; live Plaid Sandbox sync → discover → create-linked
  → resolve → exact-id cleanup; idempotency/concurrency; decryption/provider failure writes-nothing;
  no-merge/no-convert; totals/projection authority + warnings; UI scope) + authenticated-HTTP browser run
  + typecheck + build + all regressions green + secret scan clean. Owner's real Sandbox connection
  untouched. Older suites' superseded `!/plaid/i`/migration/scope guards updated (disclosed NOTEs).

### ADR-032 — Finance 1B.3B: verified Plaid Sandbox webhooks + automatic sync
- **Classification:** Owner-approved decision (owner approved the 1B.3B scope).
- **Detail:** Adds **automatic** transaction sync via a verified Plaid webhook — still Sandbox-only,
  read-only, owner-only; **no** Production, OAuth, matching, bill/income/transfer confirmation, AI, or
  money movement. A webhook is only a NOTIFICATION; transactions are always retrieved through the
  existing `/transactions/sync` lifecycle.
  - **Dependency:** `jose` (maintained JWT/JWK library) for ES256 verification — never hand-rolled crypto.
  - **Trust = cryptography, not the login session.** `POST /api/webhooks/plaid` is **public** (exempt
    from the owner-session gate in `middleware.ts`). The verifier (`lib/providers/plaid/webhook.ts`)
    reads the exact raw body, requires the `Plaid-Verification` JWT to be **ES256**, fetches the matching
    public key by `kid` from Plaid's verification-key endpoint (cached by **env+kid**, bounded TTL, never
    caching tokens), verifies the signature, rejects a stale `iat` (5-min window), and constant-time-
    compares SHA-256 of the **exact raw body** to the signed `request_body_sha256`. Missing/malformed/
    wrong-alg/unknown-key/bad-sig/stale/body-mismatch all fail closed.
  - **Durable intake + idempotency:** `plaid_webhook_events` (migration `0015`, additive) stores ONLY
    bounded non-secret metadata (NO token, encryption fields, raw payload, account numbers, or
    transaction data). Idempotent by `body_hash` (unique) — a duplicate delivery creates no second event
    or job. Only `TRANSACTIONS / SYNC_UPDATES_AVAILABLE` acts; other validly-signed events are `ignored`.
  - **Processing mechanism (reliability correction — ack fast, process durably in the background):** the
    route **verifies → durably stores the event → triggers a Netlify Background Function → ack's
    promptly**. It does **NOT** run the full sync inline (Plaid's 10-second window is not safe for cold
    starts + multi-page + retries). The ack means only "the verified notification was safely received".
    The **active primary processor** is `netlify/functions/process-plaid-webhooks-background.mts` (the
    `-background` suffix → returns 202, runs ~15 min, Netlify auto-retries). It claims pending/failed/
    **stale-`processing`** events **atomically** (so overlapping invocations can't double-process), runs
    the **existing** fetch→buffer→atomic sync, marks `processed` only on success, and on failure
    preserves the event (bounded retry) + the prior cursor + imported state. **Stale-claim recovery:** a
    `processing` claim older than **5 minutes** (a crashed/timed-out worker) is re-claimable, so a
    verified event is never lost. The **active recovery backstop** is the scheduled drainer
    `netlify/functions/drain-plaid-webhooks.mts` (**enabled** in-code, every 10 min, small bounded batch)
    — it catches anything the background invocation missed via the same atomic claim. The **manual Sync
    transactions** button remains. **Invariant:** every verified supported event is recoverably pending/
    processing/failed or durably processed/ignored — never acked then silently lost.
  - **Webhook config:** new Link tokens include `PLAID_WEBHOOK_URL` (server-only) when set;
    `configureConnectionWebhook` updates an existing Item's webhook via Plaid's Item webhook-update
    endpoint (fails closed / degrades truthfully when the URL is unset). The URL is never exposed to the
    browser as a secret. Unknown items + non-sandbox connections mutate no owner data.
  - **Internal processor access control (correction):** the Background Function endpoint is publicly
    reachable, so it requires a **dedicated server-only secret** `PLAID_WEBHOOK_PROCESSOR_SECRET` (NEVER
    `PLAID_SECRET`, `BANK_TOKEN_ENC_KEY`, a session secret, an access token, or the webhook JWT) in a
    bounded header `X-Xanther-Webhook-Processor-Key`, **constant-time compared** (`timingSafeEqual`,
    length-guarded) **before any DB query, claim, or Plaid call**. Missing/incorrect → generic **401**
    with no work; a missing server-side secret **fails closed**; the credential is never logged or
    returned. The webhook route supplies it **server-to-server only** (never to Plaid/browser/Link token).
    The **scheduled drainer** calls the shared service **directly** from trusted Netlify execution — it
    needs no HTTP secret and stays the recovery path when the trigger is unauthorized/fails. If the secret
    is unset, the UI says background processing isn't fully configured (manual sync still works).
    **Invariant:** no unauthenticated/incorrectly-authenticated caller can cause webhook-event processing.
  - **Worker-dispatch correction (live-deploy fix):** the Next.js login middleware (a Netlify **edge
    function**) matched `/.netlify/functions/*`, so it **307'd the server-to-server worker trigger to
    /login** and the worker was never invoked (events stuck at `received`, `attemptCount=0`). Fix
    (narrow, defense-in-depth): the middleware now **bypasses `/.netlify/functions/`** (early code return
    + matcher exclusion `\.netlify/functions`) — owner pages/APIs stay gated, and worker authorization is
    still the in-function `X-Xanther-Webhook-Processor-Key` check. The route's trigger is no longer
    fire-and-forget: it uses `redirect: "manual"`, **classifies the response**, and treats only the
    documented Netlify Background Function acceptance (**HTTP 202**) as a successful dispatch — a login
    redirect / HTML fallback / 401 / 404 / 5xx / network error is a bounded, non-secret, non-URL logged
    failure that leaves the durable event recoverable by the scheduled drainer. **Invariant:** a verified
    event is never reported as dispatched merely because the trigger was redirected to or rendered by the
    login page.
  - **UI status (truthful):** the owner-facing line distinguishes not-configured / **processor-not-
    configured** / notification received (syncing) / automatic sync failed (retrying) / automatic updates
    on + last automatic sync — it never claims automatic updates are working merely because a URL is set.
    Manual sync stays available.
- **Evidence:** `scripts/verify-finance1b3b.ts` (93/93, incl. accept + 8 reject paths, idempotent
  intake, atomic claim, retry + exhaustion, failure-preserves-cursor, a LIVE webhook → real Plaid sync,
  unknown-item/no-mutation, owner protection, the reliability correction `[R1]–[R20]`, **+ the access-
  control correction `[A1]–[A20]`: missing/incorrect/correct-header auth, timing-safe compare, fail-
  closed-when-unset, unauthorized-does-no-work, no-credential-in-responses/logs/bundles, server-to-server
  only, drainer-recovers-without-secret, and the no-unauthenticated-processing invariant**) + all
  regressions green + typecheck + build + secret scan + a public-route reject test + authenticated
  `/finances` render. Owner's BofA connection + 19 imported transactions + Plaid Checking preserved.

### ADR-031 — Finance 1B.3A.1: Imported-activity usability + test-cleanup hardening
- **Classification:** Owner-approved decision (owner approved the 1B.3A.1 polish-and-safety scope).
- **Detail:** Two bounded changes, **no** new schema/route/provider work (no webhooks, matching, AI,
  Production, OAuth, money movement; the 1B.3A fetch→buffer→atomic-commit sync is unchanged).
  - **Imported Activity usability:** `/finances` now shows only the most recent **10** transactions by
    default with **Show more** / **Show less**, plus small **Account** / **Status (All/Posted/Pending)**
    / **Date (Last 30 / Last 90 (default) / All history)** filters and a truthful **"Showing X of Y"**
    count. All filtering + pagination is **client-side** over a single bounded, deterministically-ordered
    fetch (the service gained a stable `id` tie-breaker and the view a `financialAccountId`); filters
    never trigger a sync or mutate data; removed + suppressed-pending rows stay excluded. Imported
    Activity remains clearly separate from Recent (Xanther) Activity. Responsive at 375px.
  - **Test-cleanup hardening:** a shared `scripts/support/bank-test-cleanup.ts` (`cleanupBankTestRecords`,
    `sweepStaleTestAccounts`, `orphanLinkedCount`) gives every bank harness (`verify-finance1b1/1b2/1b3a`)
    **exact-ID, safe-FK-order, idempotent** cleanup that runs on a pass, an assertion failure, a
    provider/db throw, OR an interruption. Root cause of the earlier `ZZ1B2` leak: a finally that ran a
    **raw `DELETE financial_accounts` which FK-violated (a provider account still referenced it) and
    swallowed the error** — fixed by always unmapping before deleting. A startup **sweep** removes
    provably-test (`ZZ`-prefixed) leftovers by exact id and **refuses** if a real owner name matches;
    prefix scanning is a final diagnostic only, never the primary cleanup.
- **Evidence:** `scripts/verify-finance1b3a.ts` (131/131, incl. `[u1]–[u24]` usability + `[k25]–[k42]`
  cleanup-hardening incl. cleanup-after-provider/db/assertion-failure and the no-durable-orphan
  invariant) + all regressions green + typecheck + build + secret scan + authenticated-HTTP render.
  The owner's real BofA imported transactions (19) and Plaid Checking linked account are preserved.

### ADR-030 — Finance 1B.3A: Plaid Sandbox transaction import + manual incremental sync
- **Classification:** Owner-approved decision (owner approved the 1B.3A scope).
- **Detail:** A manual **`Sync transactions`** action imports fake Plaid Sandbox transactions as
  **bank EVIDENCE, not Xanther commands** — read-only, owner-only, Sandbox-only, **no matching, no
  bill/income/transfer confirmation, no AI, no money movement, no webhooks** (webhooks deferred to
  Finance 1B.3B).
  - **Evidence vs command ledger:** imported transactions live in their own `imported_transactions`
    table + read model. They **never** create an `account_movements` row, **never** mutate a provider/
    manual balance, and **never** confirm a domain record. `/finances` shows a separate **Imported
    activity** section, distinct from **Recent activity** (the Xanther/manual-command ledger).
  - **Adapter:** `syncTransactions` (Plaid `/transactions/sync`) + `normalizePlaidTransactionAmount`
    (Plaid is outflow-positive → Xanther inflow +, outflow −; **$0 is the documented exception — it is
    skipped**, not stored). Raw Plaid types stay inside `lib/providers/plaid/`.
  - **Schema:** additive `0014_bouncy_arclight.sql` — `imported_transaction_status` enum (`active|
    removed`) + `imported_transactions` table (connection-scoped unique `(connection_id,
    provider_transaction_id)`; FKs: user cascade, connection **cascade**, financial_account **SET NULL**;
    bounded normalized fields only — **no raw payload, no token, no cursor here**) + 6 nullable
    transaction-sync columns on `financial_connections` (`transactions_cursor`,
    `last_transaction_sync_attempted_at`/`_synced_at`, `transaction_sync_locked_at`, error code/message).
  - **Atomic fetch → buffer → commit (pagination correction):** per Plaid's pagination guidance, the
    **entire page sequence is fetched into memory FIRST (no durable writes)**, then the complete
    aggregated patch (added/modified upserts + removed tombstones) is applied together with the final
    cursor + success timestamp in **ONE writable-CTE statement** (neon-http has no interactive
    transactions, so a single statement IS the atomic unit — it rolls back wholesale on any error). A
    `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` **discards the in-memory accumulation and restarts
    from the original committed cursor** (bounded to 5 retries → then a bounded error). Reaching the
    25-page limit while `has_more` is still true **fails closed** (no patch, cursor preserved). Any
    provider/normalization/DB-apply failure persists **no** patch and preserves the prior cursor +
    prior success timestamp. `lastTransactionSyncedAt` advances only when the apply statement commits.
    Aggregation is deterministic (provider order; last event per id wins; a txn in both upsert+remove
    categories resolves to its last event, keeping the two CTE sub-updates on disjoint rows).
  - **Added/modified/removed:** added/modified upsert by `(connection_id, provider_transaction_id)`
    (`firstSeenAt` preserved, `lastUpdatedAt` bumped); **removed → tombstone** (`status='removed'` +
    `removedAt`, never hard-deleted, excluded from active); an **unknown removal is safely ignored and
    counted** (the documented deterministic rule — no invented row).
  - **Pending → posted:** a pending row is suppressed from active views once an active posted row
    references it via `pendingProviderTransactionId` (Plaid also tombstones the pending one) — no
    permanent double-count; the relationship is preserved; **no guessed** relationship is created.
  - **Concurrency:** a **per-connection DB lock** (`transaction_sync_locked_at`, claimed atomically,
    5-min stale reclaim, released in a finally) + the connection-scoped unique index prevent cursor
    corruption + duplicate rows. A decryption/provider failure writes nothing.
  - **Routes:** `POST /api/finances/connections/[id]/transactions/sync` (manual, nonsecret counts) +
    `GET /api/finances/transactions` (owner-scoped nonsecret views; no token/provider-txn-id/account
    number). userId/cursor/token/provider ids are never trusted from the browser.
- **Evidence:** `scripts/verify-finance1b3a.ts` (93 assertions; live Plaid Sandbox inject→sync +
  injected-fake-provider for added/modified/removed/pending-posted/concurrency + the **20 atomic
  fetch→buffer→commit checks** (fetch-before-write, page-2 failure writes no page-1 add/modify/remove,
  mutation-discard+restart, retry/page-limit fail-closed, DB-apply rollback preserves cursor+timestamp,
  cross-page pending→posted + add/modify/remove, idempotent replay) + the "no mutation from a
  failed/abandoned attempt remains durable" invariant; domain separation; UI scope) + authenticated-HTTP
  browser run + typecheck + build + all regressions green + secret scan clean. Owner's real Sandbox connection + `Plaid Checking` linked account untouched.
  Superseded scope guards in 1A.3A/1B.0/1B.1/1B.2 updated (disclosed NOTEs).

### ADR-028 — Finance 1B.1: Plaid Sandbox connection flow
- **Classification:** Owner-approved decision (owner approved the 1B.1 scope + configured the Plaid
  Sandbox env vars in Netlify).
- **Detail:** Xanther's first real provider connection — **Plaid Sandbox only, read-only, owner-only,
  fake test data, no money movement.** Stops before accounts, balances, transactions, webhooks, and
  matching.
  - **Dependency:** the official `plaid` server SDK (`plaid@^42.2.0`) — imported only inside
    `lib/providers/plaid/` (client + adapter). The browser uses Plaid's official Link CDN script (no
    extra npm dependency, no Plaid SDK in the client bundle).
  - **Adapter:** `lib/providers/plaid/adapter.ts` implements the 1B.0 `BankProvider` subset
    (`createLinkSession`, `exchangePublicCredential`, `getConnectionMetadata`, `revokeConnection`);
    every other method throws "not implemented in 1B.1". Raw Plaid types never escape the folder.
  - **Sandbox guard:** `lib/providers/plaid/env.ts` reads creds lazily and **fails closed** — `PLAID_ENV`
    must be exactly `sandbox`; the client is pinned to the Sandbox base path, so no Production endpoint
    is reachable. Rejection messages name the variable, never its value.
  - **Schema:** additive migration `0011_rapid_sasquatch.sql` — new `connection_status` enum + the
    `financial_connections` table. The access token is stored **only** as the AES-256-GCM envelope
    (`access_token_cipher`/`_nonce`/`_tag`/`_key_version`/`_envelope_version`) — **no plaintext-token
    column**. `provider_item_id` is unique within `(user_id, provider)`, so a repeated exchange of the
    same Item can never create a second row. No owner-data backfill; no later-phase tables.
  - **Flow:** `lib/services/connections.ts` orchestrates create-link → exchange → encrypt → store. The
    plaintext token is encrypted before any DB write and never returned or logged. Duplicate/retry is
    idempotent (returns the existing nonsecret view); a Plaid failure or an encryption failure writes
    **nothing**; the owner id is server-resolved (never trusted from the request body).
  - **Routes:** `POST /api/finances/connections/link-token` (returns only `linkToken`+`expiresAt`),
    `POST /api/finances/connections/exchange` (returns only a nonsecret connection view),
    `GET /api/finances/connections` (nonsecret views), `DELETE /…/[id]` (owner-scoped Sandbox cleanup —
    revoke + delete only the connection row).
  - **UI:** a `Bank connections` section on `/finances` (Connect bank, Sandbox explanation, connection
    list with a `Sandbox` badge + status) — **no accounts, balances, or transactions** are shown.
  - **Env (Netlify):** the owner entered `PLAID_CLIENT_ID`/`PLAID_SECRET`/`PLAID_ENV`/`BANK_TOKEN_ENC_KEY`
    via Netlify's `.env` import; no downloaded `.env` and no Google Drive are required. Local runs need
    the same names (e.g. an untracked `.env.local` or `netlify dev`).
- **Evidence:** `scripts/verify-finance1b1.ts` (65/66 invariants; live Plaid Sandbox end-to-end via
  `sandboxPublicTokenCreate` → exchange → encrypted store → idempotent duplicate → exact-id cleanup) +
  authenticated-HTTP browser-equivalent run against the dev server (section render, link-token,
  connected-state persistence, 401 on no-auth, no-secret errors) + typecheck + build + all regressions
  green + secret scan clean. Older suites' stale `!/plaid/i` guards were updated (disclosed NOTEs).

---

## Open decisions — `[DECISION NEEDED]`

Mirror of the open questions in `PRODUCT_VISION.md`; record answers here when made:

- `[DECISION NEEDED]` Definition of success / metrics.
- `[DECISION NEEDED]` First complete end-to-end workflow to build.
- ~~`[DECISION NEEDED]` First AI-assist capability and its cost ceiling.~~ **Answered** —
  owner-triggered Experience interpretation with a $5/mo dev ceiling + per-op caps
  (ADR-011, ADR-013).
- `[DECISION NEEDED]` Shape of the public-identity surface.
- `[DECISION NEEDED]` If/when to adopt an automated test framework, and which.
