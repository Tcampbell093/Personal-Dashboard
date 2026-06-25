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
