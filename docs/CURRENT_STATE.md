# Current State

> What is actually in the repository, classified by maturity. Keep it factual and update it
> after every substantive change (see `CLAUDE.md`). For the durable product vision, see
> `docs/PRODUCT_VISION.md`; for the approved product direction (mission, the five permanent functions,
> the recommendation lifecycle, and the strategic sequence), see `docs/PRODUCT_ALIGNMENT.md`; for the
> first Daily Command Center / Personal Advantage Loop design (documentation-only; not yet approved to
> build), see `docs/DAILY_COMMAND_CENTER_SPEC.md`.
>
> **Product name:** the application is **Xanther** (a private AI-powered personal operating
> system / Life OS). *Personal Command Center* and other prior names are historical aliases
> only; technical identifiers (routes, DB, env vars, the `Personal-Dashboard` repo) keep their
> original names. See `docs/DECISIONS.md` ADR-026.

**Last updated:** 2026-07-01 · **Reflects branch:** `main` @ `ca4fcdb` (Finance 1B.5B live; **Finance 1C.0A — manual credit profile + financial-health baseline — reviewed, merged to `main`, locally production-build verified, and expected to auto-deploy; live production verification unconfirmed**)

> **Daily Command Center — Slice 1 (signal contract + read-only providers) — reviewed and merged to `main`
> (commit `0e64a64`; review branch deleted).** A shared, **read-only** `DailySignal`
> contract (`lib/daily/contract.ts`) + **nine** deterministic grounded providers (`lib/daily/providers.ts`)
> that map existing domain services (tasks, obligations, bills, finance outlook, credit, spending
> opportunities, credit goals, data-quality, planned experiences) into a common signal shape — reusing
> existing services, mutating nothing, with honest provenance (`observed_fact` / `deterministic_calc` /
> `inferred_interpretation` / `recommendation`), stable keys, and empty arrays when nothing qualifies.
> Freshness is **recompute-based** for live/unresolved facts (tasks/obligations/bills/finance/credit/
> goals/data-quality use `today + freshnessDays`, so an unresolved overdue item never looks expired;
> future planned experiences keep event-relative freshness); spending opportunities never emit potential
> savings as a cost. **No schema/migration, ranking, orchestration, persistence, API, UI, AI, or Home
> integration** (those are later DCC slices). `scripts/verify-daily-slice1.ts` = **81/81**; all regressions
> green. See `docs/DAILY_COMMAND_CENTER_SPEC.md` §4/§17.

> **Finance 1C.0A — manual credit profile + financial-health baseline — reviewed, merged to `main`
> (commit `ca4fcdb`), locally production-build verified, and expected to auto-deploy.** Passed code review
> (three fixes landed: soft-deleted score/inquiry dedupe lifecycle via live-only partial indexes +
> migration `0021`; full inline edit/delete/archive UI with error surfacing; goal-retype target
> re-validation). Harness **127/127**; the review branch is deleted. **Live production commit/UI
> verification remains unconfirmed due to the Netlify site-level password and unavailable deploy-status
> API** — the deployed Credit UI was verified pre-merge on a local build, not re-inspected in the deployed
> environment.
> A **manual, owner-entered, read-only** credit profile + **deterministic** financial-health engine:
> score snapshots (with source/bureau/model — different sources are **never averaged**, trends are
> same-source only), revolving/installment accounts, collections, late payments, hard/soft inquiries,
> and credit goals → utilization math (per-account + aggregate over open revolving accounts with valid
> limits; amounts to reach <50/30/10%; installment excluded; missing/zero limits warned; authorized-user
> explicit), credit-history + collections summaries, **12 observation types**, **10 prioritized
> action-card types**, and a six-section health summary. Six new additive tables (migration `0020`); the
> engine is a **calculated view** (never persisted). **Hard boundaries:** no credit-bureau API, no Credit
> Karma, no scraping/browser automation, no dispute automation, no debt settlement, no lender/application,
> no Production Plaid, no AI freeform advice, **no money movement** — and it mutates **no** transaction/
> category/rule/balance/movement/snapshot/cursor/bill/income/transfer/evidence. **No guarantees:** never
> claims a fixed score gain, that paying a collection improves a score, or that a debt is valid; every
> collection path warns **verify-the-debt-and-get-written-terms first**; cash-flow context (reused from
> `computeFinancialOutlook`) flags risky actions and never recommends rent/essential-bill funds. Each
> action card exposes a stable **Personal Advantage Engine** shape (domain/actionType/urgency/upside/
> cost/time/risk/confidence/evidence/nextStep/professionalVerificationRecommended) for a later engine
> (not built here). `/finances` gains a tabbed **Credit & financial health** section (Overview / Credit
> profile / Goals / Guidance, with add/edit flows + manual/stale warnings); Home shows ≤1 action + ≤1
> progress + stale reminder; `/manage` unchanged. `scripts/verify-finance1c0a.ts` = **125/125** +
> browser-verified (desktop + 375px). See `docs/DECISIONS.md` ADR-037.

> **Finance 1B.5B — spending insights + financial opportunity detection — implemented (uncommitted).**
> Turns categorized transactions into explainable, **read-only** deterministic **spending insights** and
> **opportunity cards** — each separating observed fact, calculation, inferred opportunity, estimated
> upside, confidence, and limitation. Insights are a **calculated view** (recomputed per request, never
> persisted); the only durable state is **dismissal** (new additive table `financial_insight_dismissals`,
> migration `0019`, keyed by a deterministic period-scoped insight key, idempotent). Generation is strictly
> read-only: it changes **no** transaction/category/rule/balance/snapshot/movement/cursor/bill/income/
> transfer/matching-evidence and **moves no money**. Spending excludes inflows, confirmed transfers, and
> removed/pending rows; periods (this month MTD-vs-equal-days, last month, last 30, last 90, custom month)
> are bounded in America/New_York. Detection is conservative + documented (`THRESHOLDS`): change (abs ≥ $25
> **and** ≥ 20% **and** current ≥ $40), recurring (≥ 3 similar-amount charges at a consistent cadence),
> fee (`\bfee\b` word boundary — never "coffee"), unusual (≥ 2.5× merchant median **and** > median + $50,
> ≥ 4 history), concentration (> 35%), coverage warn (> 25% uncategorized). Opportunities bound reduction
> estimates to ≤ 50% of observed spend and never assume avoidability/cancellation; **low-confidence
> opportunities are hidden by default**. Insights/opportunities are **priority-sorted before** the ≤8/≤5
> slice so a fee leak or unusual charge is never crowded out. `/finances` gains a **Spending insights**
> section (period chips, totals, coverage warnings, category breakdown with bars, top merchants, insight
> cards with confidence + evidence + "Why am I seeing this?" + Dismiss, opportunity cards); Home shows at
> most one insight + one opportunity (rolling last-30-day window) beside the categorization count;
> `/manage` unchanged (no auto task creation). `scripts/verify-finance1b5b.ts` = **108/108** + browser-
> verified (desktop + 375px). See `docs/DECISIONS.md` ADR-036.

> **Finance 1B.5A — transaction categories + merchant rules — implemented (uncommitted).** Owner-editable
> spending **categories** (20 defaults bootstrapped idempotently at app level), **descriptive-only**
> category assignments on imported transactions, **deterministic** suggestions (no AI), and **explicitly**
> owner-approved reusable **merchant rules**. New additive tables `transaction_categories`,
> `transaction_category_assignments`, `merchant_category_rules` (migration `0018`). Categorization is
> metadata stored separately — it changes **no** transaction field, balance, movement, provider snapshot,
> cursor, bill/income/transfer, or matching evidence, and moves no money. A merchant rule is only ever
> created by **explicit** owner action (a correction never silently learns one); rule behavior is
> **Suggest** (default) or **Auto-categorize**, with optional **apply-to-existing** (unchecked by
> default; bounded/idempotent; skips confirmed + removed). DB partial-unique indexes enforce one current
> confirmed + one current suggested per transaction; conflict precedence is deterministic (owner > exact
> auto rule > exact suggest rule > broader rule > non-rule suggestion > Uncategorized). `/finances` gains
> a **Categorize transactions** review queue (bounded 10, filters, selector, Confirm/Change/Reject,
> confidence + explanation, in-card rule dialog) + a **Categories & merchant rules** panel; Imported
> Activity rows show the current category; Home shows a compact "N transactions need categorization"
> count. `scripts/verify-finance1b5a.ts` = **108/108**. See `docs/DECISIONS.md` ADR-035.

> **Finance 1B.4B — evidence-only confirmation for linked income + transfers — implemented (uncommitted).**
> The two cases 1B.4A failed closed — **linked-account income receipts** and **linked→linked transfer
> pairs** — can now be owner-confirmed via an **evidence-only** path: imported bank transactions PROVE the
> planned event happened, with **no** account movement, manual/provider balance change, provider-snapshot
> recompute, synthetic debit/credit, Plaid-transaction or sync-cursor change, duplicate receipt, or
> double-counted transfer (the money already lives in the provider-authoritative linked balance). New
> additive table `financial_event_evidence` (migration `0017`) distinguishes **`manual_workflow`** (the
> existing movement-writing completion) from **`linked_evidence`** (movement-free proof), keyed uniquely
> per owner for idempotency; plus a new additive `income_status` value **`received_evidence`**. The
> confirm route routes bill → `payBill`, manual-destination income → `receiveIncome`, **linked income →
> evidence-only** (occurrence → `received_evidence`, no movement), **linked→linked transfer → evidence-
> only** (no movement, no transfer row); **mixed linked/manual transfers fail closed** (no hybrid
> double-count); manual→manual keeps the existing transfer workflow. Suggested matches now shows Confirm
> for linked income/transfers behind a dialog stating exactly what will (and won't) change, plus a
> **Show confirmed** evidence view. `scripts/verify-finance1b4b.ts` = **79/79**. **No AI, Sandbox-only,
> owner-confirmed.** See `docs/DECISIONS.md` ADR-034.

> **Finance 1B.4A — deterministic transaction-matching suggestions — implemented (uncommitted).**
> Xanther now **suggests** how imported bank evidence may relate to the owner's finance records —
> **suggestion-only, owner-confirmed, deterministic (no AI), Sandbox-scoped, no money movement.** Three
> types: `bill_payment`, `income_receipt`, `transfer_pair`. A new durable table
> `transaction_match_suggestions` (migration `0016`, additive) stores each candidate with a bounded
> **0–100 score**, **confidence band** (high ≥80 / medium 60–79 / low 50–59; min 50 to persist),
> explainable **reason codes**, and amount/date differences. Generation is a manual **Find matches**
> button (`POST /api/finances/matches/generate`) — idempotent (upsert by `(userId, matchKey)`), preserves
> confirmed/rejected decisions, supersedes invalid ones, never reopens a rejected relationship, and
> mutates **no** bill/income/transfer/movement/balance/snapshot/cursor. Owner **Confirm/Reject** via
> `/api/finances/matches/[id]/confirm|reject`. **Confirmation = fail-closed reuse:** bill confirm reuses
> `payBill` (linked paid-account → mark paid + evidence, no balance change); income confirm reuses
> `receiveIncome` (manual destination only); **transfer confirmation + linked-destination income are a
> documented model gap and fail closed** (the UI shows "confirmation not yet supported" and offers no
> Confirm button — still reviewable/rejectable). `/finances` gains a **Suggested matches** section
> (pending default, type filters, confidence + explanation, bounded 5 + show more/less, medium-confidence
> confirm dialog, truthful empty states); Home shows only a compact "N transaction matches need review"
> count. `scripts/verify-finance1b4a.ts` = **82/82**. See `docs/DECISIONS.md` ADR-033.

> **Finance 1B.3B — verified Plaid Sandbox webhooks + automatic transaction sync — committed & pushed
> (`3f7e617`); awaiting deployment config + live Sandbox webhook verification.** A **public** `POST
> /api/webhooks/plaid` cryptographically verifies the Plaid webhook
> (ES256 signature via `jose` + raw-body hash + 5-min `iat`), durably records a bounded non-secret event
> (`plaid_webhook_events`, migration `0015`, idempotent by body hash), then **ack's promptly** and runs
> the existing fetch→buffer→atomic sync **in a Netlify Background Function** (`process-plaid-webhooks-
> background.mts`) — so Imported Activity updates **without** pressing Sync, and the route never risks
> Plaid's 10s window. Trust is the signature, not the login session (route is gate-exempt). Atomic
> claims + **stale-`processing` recovery (5 min)** + an **enabled** scheduled drainer backstop (every
> 10 min) make a verified event **never silently lost**; failures preserve the cursor + imported state
> for bounded retry; the **manual Sync button remains**. The Background Function endpoint is **access-
> controlled** by a dedicated server-only secret `PLAID_WEBHOOK_PROCESSOR_SECRET` (bounded header,
> constant-time compare, fail-closed, rejected before any DB/Plaid work, server-to-server only); the
> scheduled drainer needs no HTTP secret. The auto-update UI status is truthful (configured / processor-
> not-configured / received / syncing / failed / last sync). Still Sandbox-only, read-only, no
> matching/Production/OAuth/money-movement. See `docs/DECISIONS.md` ADR-032.
> **Deployment status (2026-06-29, names only):** migration `0015` is **applied** to the shared Neon DB;
> `PLAID_WEBHOOK_URL` and `PLAID_WEBHOOK_PROCESSOR_SECRET` are **not yet configured** (must be set in
> Netlify); the owner's BofA Sandbox Item has **no webhook configured yet** (left unchanged until the
> deployed URL is set). Live Sandbox webhook verification is pending. See `docs/HANDOFF.md`.

> **Finance 1B.3A.1 — Imported-activity usability + test-cleanup hardening — implemented (uncommitted).**
> `/finances` Imported Activity now shows the most recent **10** transactions with **Show more/less** +
> **Account / Status / Date (default Last 90 days)** filters + a truthful **"Showing X of Y"** count
> (client-side over one bounded deterministic fetch; filters never sync or mutate). The bank
> verification harnesses gained shared **exact-ID, safe-order, cleanup-on-every-exit-path** teardown +
> a startup stale-test sweep (fixes the earlier `ZZ1B2` leak). **No** schema/route/provider change; the
> 1B.3A sync lifecycle is unchanged. See `docs/DECISIONS.md` ADR-031.

> **Finance 1B.3A — Plaid Sandbox transaction import + manual incremental sync — implemented
> (uncommitted).** A manual **Sync transactions** action imports fake Plaid Sandbox transactions as
> **bank evidence** into a new `imported_transactions` table + an **Imported activity** `/finances`
> section, kept **separate** from the Xanther/manual-command ledger (`account_movements`). Amounts are
> Xanther-signed (inflow +, outflow −; $0 skipped). Cursor-safe incremental sync (the committed cursor
> advances only after all pages persist), idempotent upserts, removed→tombstone, pending→posted
> suppression (no double-count), a per-connection DB lock. **Read-only, owner-only, Sandbox-only — no
> matching, no bill/income/transfer confirmation, no webhooks (deferred to 1B.3B), no AI, no money
> movement, no balance mutation.** Additive migration `0014`. Verified against **live Plaid Sandbox**
> (`scripts/verify-finance1b3a.ts`, 93 assertions) + authenticated-HTTP. See `docs/DECISIONS.md` ADR-030
> + `docs/BANK_INTEGRATION_SECURITY.md`.

> **Finance 1B.2 — Plaid Sandbox accounts + cached balances — committed `e107322`.** From
> `/finances`, the owner can **Sync accounts** on a Sandbox connection → discovered fake provider
> accounts render with masked ids, **cached** balances, currency, and truthful freshness → the owner can
> **Add to Xanther** an unmapped provider account, creating a **new linked account** (`balanceSource =
> linked`) that appears in the Accounts section with a provider-authoritative balance (or **Balance
> unavailable**), no manual editing, and no reconciliation. Existing manual Chase/BofA are never merged
> or converted (existing-manual mapping is deferred). A connection with a linked account **cannot be
> hard-deleted** (FK `NO ACTION` + a 409 guard prevents orphaned linked accounts). **Read-only,
> owner-only, no money movement, no transactions/webhooks/matching.** New `provider_accounts` table
> (migration `0012`; constraint-only `0013` makes the connection FK `NO ACTION`); adapter
> `listAccounts`/`getCachedBalances` via cached `/accounts/get` (no paid real-time endpoint). Verified
> against **live Plaid Sandbox** (`scripts/verify-finance1b2.ts`, 84 assertions incl. orphan-prevention)
> + authenticated-HTTP. See `docs/DECISIONS.md` ADR-029 + `docs/BANK_INTEGRATION_SECURITY.md`.
>
> **Finance 1B.1 (committed `aa868b5`)** added the Plaid Sandbox connection flow (`financial_connections`,
> encrypted token, link/exchange/list routes, Bank-connections UI). **1B.0 (`d6497eb`)** established the
> provider-neutral contracts, sign convention, balance-authority resolver, and token-encryption module.

## Status legend

- **✅ Verified working** — behavior **actually exercised during this documentation session**
  in local dev (direct API calls and/or loading the rendered page). There is **no automated
  test suite**, so "verified" means manually exercised here, not by CI.
- **🟡 Partially implemented** — works in part; notable gaps.
- **◻️ Implemented but unverified this session** — code exists and likely works, but was **not
  exercised** during this session (inferred from code, not demonstrated).
- **⚪ Mock / placeholder** — present to make the UI render or reserved in schema; not real.
- **📐 Designed, not implemented** — schema/affordance exists; no behavior.
- **⚠️ Known risk / configuration requirement** — must be understood before relying on or
  deploying the app.

## Stack (from `package.json`, configs)

Next.js 15 (App Router) + React 19 + TypeScript · Neon PostgreSQL via
`@neondatabase/serverless` (HTTP) · Drizzle ORM + drizzle-kit · `jose` for the auth cookie ·
Netlify as the (not-yet-used) hosting target · hand-written CSS, no UI library.

## ✅ Verified working (exercised this session, local dev)

Exercised via **direct API calls (curl)** against a real Neon database and/or by **loading the
rendered page**. No browser-driven UI clicks and no automated tests were run.

- **All seven verticals — create / list / a status-change / delete via their API routes**,
  against real Neon, including validation error cases: tasks, obligations, finances
  (accounts, bills, income), signals, opportunities, jobs, interest.
- **Financial outlook** (`computeFinancialOutlook()`) computed from real rows and checked
  against known inputs, including recompute after marking a bill paid.
- **Password gate** end-to-end: unauthenticated page → 307 redirect to `/login`;
  unauthenticated API → 401; correct password sets a session cookie; logout clears it.
- **Dashboard renders** (HTTP 200) with live data and the expected add-forms present.
- **Experience and Adventure Loop — Build 1 (manual)**, exercised via API (25/25 checks)
  against real Neon and verified at the DB level: request create/edit/validation;
  home-area prefill **isolation** (editing a request's location leaves
  `user_preferences.homeArea` unchanged — DB-confirmed); duplicate-plan protection (409);
  manual plan creation; edit-while-planned; one-way resolution to
  completed/cancelled/not_completed; **post-resolution outcome correction**; server-side XP
  (completed 10, completed+meaningful 15, cancelled/not_completed 0) including recalculation
  when `meaningful` toggles 10↔15; resolved status cannot return to `planned` or change to
  another resolved status; invalid rating / negative amounts rejected; client `userId` and
  `adventureXp` ignored (DB-confirmed `userId === 1`); non-owned ids → 404; `/experiences`
  renders (HTTP 200) with all five sections and **no mock fallback**.
- **Experience delete-and-recovery + empty-enum handling** — soft-deleting a **planned**
  experience returns its request to `draft` (re-plannable); deleting a **resolved** one leaves
  it `planned`; optional enum selects left at "—" (empty string) normalize to `null` with no
  DB `500` (valid values accepted, invalid non-empty → 400, omitted PATCH fields unchanged).
- **Experience workflow — full browser click-through (20-step pass)** completed via the
  preview browser: nav link → request → prefill (and home-area isolation, DB-confirmed
  unchanged) → constraints saved with selects left at "—" → plan created with difficulty "—"
  → refresh persistence → edit → complete (XP 10) → meaningful 10↔15 → cancel/not-completed
  (XP 0) → planned-delete recovery → resolved status not editable in UI → mobile layout → no
  mock data.
- **Experience interpretation — Build 2A (AI-assisted, owner-triggered)**, verified
  **deterministically without a live key** (`scripts/verify-build2a.ts`, **125/125**: 26 pure
  unit + **99 database-backed**) and via the **browser** (both AI-off and a fake-seeded
  AI-interpreted state). The unit layer covers output validation (shape/enum/range/date →
  `invalid_ai_output`), pricing/cost math, the budget gate (`per_op_limit` 422,
  `budget_exceeded` 429, configured-limit-wins), the fake provider's four scenarios, and the
  production factory (no key → `ai_unavailable`; with key → `AnthropicProvider`; **never**
  returns the fake). The **DB-backed layer drives the real orchestration + real PATCH route
  against Neon with the fake provider** (no Anthropic call): success persists
  constraints/provenance/`interpreted` status + one bounded success log with matching
  token/cost; manual edit of an interpreted constraint flips provenance to `manual`
  (provider/model null) while a `requestText`-only edit leaves it and writes no AI log; provider
  failure / malformed / invalid output leave the request unchanged with one bounded failure log
  (no retry, no raw content); and all six pre-invocation blocks (env gate, DB gate, kill switch,
  missing key, per-op cap, monthly ceiling) reject before any provider call with a zero-cost
  bounded failure row. **Cleanup is strictly ID-scoped** (only the ids the run created) and a
  **sentinel safety check** proves unrelated owner records — a live interpreted request, a
  soft-deleted request, and a real `anthropic` usage log — survive a run untouched;
  `intelligence_settings` are restored exactly (independently confirmed afterward: 0 requests,
  0 usage logs). **Browser:** with AI off, the disabled "Help me plan this" + off-note, "Start
  manually" fallback, and `POST …/interpret` → **503 `ai_unavailable`**; with a fake-seeded
  interpreted request, the "Interpreted by AI" badge + deterministic summary + populated
  constraints under "Review details" (no Recommendations section), and editing a constraint in
  the real UI flips the badge to "Manually adjusted" with provider/model cleared and **no new
  usage-log row** (desktop + 375px). Build 1 regression re-exercised. **No live Anthropic
  invocation was made** — the adapter is implemented and deterministically verified; live
  invocation is pending owner configuration.
- **Experience recommendations — Build 2B.1 (AI generation, owner-triggered)**, verified
  **deterministically without a live key** (`scripts/verify-build2b1.ts`, **113/113**
  database-backed) and via the **browser**. The orchestration (`generateRecommendations`) +
  validation + persistence are driven against Neon with the fake provider (no Anthropic call):
  a successful **"Find experiences"** persists exactly **three** validated concepts with
  **app-assigned `rec_<uuid>` ids**, status `recommendations_ready`, provenance, and one bounded
  success log (tokens/cost match, no private content); **"Find new options"** replaces the batch
  with **entirely new ids** (prior ids absent from storage); each invalid scenario (malformed /
  wrong-length / bad-costs / invalid-difficulty / bad-array) and provider failure leave the
  request unchanged with a bounded failure log and **no partial persistence**; oversized fields
  are **capped** (not rejected); all six pre-invocation gates (env, DB, kill switch, missing key,
  per-op $0.05 cap, monthly ceiling) reject **before any provider call**; **clear-on-edit**
  (editing the request text **or** a constraint) clears the batch + provenance and reverts to
  `interpreted` with no AI call; manual planning, owner scoping, and fake-provider isolation hold;
  ID-scoped cleanup + sentinel survival + exact `intelligence_settings` restore confirmed
  (independently re-queried: 0 requests / 0 usage logs). **Browser (AI off):** no recommendation
  cards before generation; "Find experiences" disabled with the off-note; a fake-seeded batch
  renders **three Experiences-identity (cyan→violet) cards** showing title, description,
  why-it-fits, cost range, duration, difficulty, location, assumptions, and a verification
  warning, with **no selection control / no "Choose this"**; editing a constraint in the UI clears
  the cards and reverts to `interpreted`; desktop + 375px single-column. Build 1 lifecycle
  (plan/resolve/XP/history/delete-recovery) and Build 2A (125/125) regress green. **No live
  Anthropic invocation was made.**
- **Experience selection + one-action plan — Build 2B.2 (completes the core workflow)**, verified
  **deterministically** (`scripts/verify-build2b2.ts`, **60/60**, incl. real `Promise.allSettled`
  concurrency races) and via the **browser**. A
  **"Choose this"** action on a recommendation card sends only `{recommendationId}`; the server
  resolves every value from the request's **current stored batch** and creates exactly one planned
  `experiences` row in a **single atomic writable-CTE statement** (confirmed compatible on the Neon
  HTTP driver) that re-checks owner scoping, not-deleted, status `recommendations_ready`, and
  id-in-current-batch, transitions the request to `planned`, and inserts the experience
  both-or-neither (partial unique index as backstop). Verified: full field mapping
  (`expectedCost = max ?? min`; `plannedDate`/`plannedTimeText` copied only from the owner's stored
  availability; labeled notes; `selectedRecommendationId` stored); batch retained; **no AI call /
  no usage-log row from selection**; manual plans carry a null id; **strict body** (extra fields or
  a full recommendation object → 422; only `recommendationId` honored, server-resolved title);
  stale/unknown id → 404, fabricated → 422, owner scoping → 404, not-ready → 409; double-click /
  different-rec → exactly one plan (409 on the loser); **unique-index conflict → 409 with the
  request still `recommendations_ready`** (atomic rollback); **real concurrent races**
  (two live calls via `Promise.allSettled`, same-rec and different-rec) each yield exactly one
  success + one 409 and one live experience matching the non-deterministic winner; planned-deletion
  recovery →
  `recommendations_ready` (batch retained) or `draft` (manual/absent id); resolved-deletion never
  reactivates. **Browser:** three cards each with "Choose this" → choose → planned experience
  appears with a subtle **"From AI suggestion"** badge and correct mapped details, **no re-entry**;
  refresh persists; cards disappear after success; delete → cards return; manual fallback intact;
  desktop + 375px. Build 1 / 2A (125/125) / 2B.1 (113/113) regress green. **No live Anthropic call
  was made.**
- **Home / Today command center — Home 1A (deterministic, default `/`)**, verified
  **deterministically** (`scripts/verify-home1a.ts`, **55/55**) and via the **browser** (desktop +
  375px). `/` is now a curated, mostly-read-only daily command center with five sections — Today
  (timezone-aware date + greeting that uses `users.name` only for a genuine name — placeholders
  like "Owner"/"User" suppress to a nameless "Good afternoon." — + a deterministic one-line
  orientation), Needs attention (ranked,
  explainable reasons), Coming up, Money awareness, Life momentum — built **only** from real
  verticals (tasks, obligations, finances, experiences/XP). The former full dashboard moved
  verbatim to **`/manage`** (one shared `ManageDashboard` component; no duplicate page). **No AI**
  (deterministic ranking via `lib/briefing.ts` `rankNeedsAttention`); two direct actions reuse
  existing islands (complete a task, mark a bill paid); experimental verticals
  (signals/opportunities/jobs/interest) are **excluded from Home** and honestly labeled
  "experimental / sample-backed" on `/manage`. Money shows only `FinancialOutlook`-supported
  figures with the wording "Estimated remaining from manually entered balances" (never
  safe-to-spend/live-balance). Sections degrade independently; a core/DB failure shows a single
  full-page "Today is temporarily unavailable" state (never mock). Verified: ranking order +
  reason labels, top-five curation, money equals `FinancialOutlook`, momentum equals `xpSummary`,
  no usage-log/AI invocation, no schema change, ID-scoped cleanup, request 222 + owner data
  untouched. Build 1 / 2A (136) / 2B.1 (126) / 2B.2 (60) regress green.
- **Manage clarity + task-completion history**, verified **deterministically**
  (`scripts/verify-manage-tasks.ts`, **27/27**) and via the **browser**. `/manage` now separates
  **Act Today** (actionable tasks with explicit "Overdue N days" / "Due today" / "Due in N days"
  labels + complete action) from **Upcoming Commitments** (obligations — dated, "not checklist
  tasks", with their own done/cancel actions) — distinguished by wording, subtitle, metadata, and
  action labels (not color alone). Completing a task no longer makes it silently vanish: it shows
  a confirmation with a short-lived **Undo**, is **retained** (status `completed` + `completedAt`,
  never hard-deleted), and appears in a **collapsed "Recently completed"** section with a
  **Reopen** action that returns it to the active list and clears `completedAt`. Home shows a small
  truthful signal ("N tasks completed today") in Life momentum when applicable. **No schema change**
  — the `tasks.completedAt` column already existed. Home 1A (55/55) and Build 2A/2B.1/2B.2
  regress green.
- **Finance 1A.1 — account-aware manual finance**, verified **deterministically**
  (`scripts/verify-finance1a.ts`, **74/74**, real services + real route handlers against real Neon)
  and via the **browser** (desktop + 375px). A dedicated **`/finances`** page (emerald Money
  identity) shows **manually entered actual balances** only — never a projection, never
  "safe to spend"/"live balance". Accounts now carry **institution, a validated type**
  (checking/savings/cash/credit/other) **and purpose** (spending/bills/savings/emergency/cash/other),
  **balanceSource** (`manual`|`linked`; always `manual` today, `linked` reserved for a future
  read-only bank connection), **includeInSpendable**, and **active** flags. Truthful rollups:
  **Total actual cash** (active cash-type accounts), **Spendable actual cash** (the
  includeInSpendable subset; savings/emergency default excluded), **Savings/emergency** surfaced
  separately, and **Credit liabilities** shown apart — **credit is never added to cash** (positive
  balance = amount owed; `netPosition = cash − credit`). Bills gained **`sourceAccountId`** and
  **`paidAccountId`** (both nullable); existing/unassigned bills stay valid and render under
  **"Payment account not assigned"** (never auto-guessed); they group by payment account on the page.
  **Marking a bill paid records status + paidAt + the account used and does NOT change any account
  balance** (browser- and DB-confirmed: Chase stayed $2,000 after a paid-from-Chase bill). The
**credit-never-spendable invariant is enforced server-side on both POST and PATCH** (a stored credit
account can never have `includeInSpendable=true`; switching credit→non-credit never auto-enables
spendable). `/manage`
  Money is reduced to a compact summary that **links to `/finances`** while **income management is
  preserved on `/manage`** (FinanceManager `sections={["income"]}`); Home's Money card links to
  `/finances`. The legacy `estimatedRemaining` is kept as a temporary compatibility figure (wording
  unchanged) but **corrected to exclude credit and inactive accounts**. Additive migration
  `0005_concerned_colossus.sql` (reviewed: only `CREATE TYPE` + `ADD COLUMN` + FK `ADD CONSTRAINT`,
  no destructive ops) applied; **owner accounts/bills survived untouched**. **No AI / no usage log**,
  ID-scoped cleanup, request 222 + owner data untouched. Build 1 / 2A (136) / 2B.1 (126) / 2B.2 (60)
  / Home 1A (55) / Manage-tasks (27) regress green.
- **Finance 1A.3A — manual bill-payment ledger**, verified **deterministically**
  (`scripts/verify-finance1a3a.ts`, **67/67**, real pay/reverse/PATCH route handlers + services vs
  real Neon, incl. **real wall-clock concurrency**) and **end-to-end through the running server**
  (authenticated HTTP: login → pay → duplicate-pay 409 → reverse → duplicate-reverse 409, with the
  rendered `/finances` SSR HTML confirmed). Paying a bill from a **manual** account now **atomically**
  (single writable-CTE statement) marks it paid with the **confirmed actual amount**, **deducts that
  amount** from the account, and appends **one negative** `account_movements` row. The transition is
  guarded by the bill's open status, so a **duplicate or concurrent payment cannot deduct twice**
  (the second gets 409, no second deduction). An **external/cash** payment (no account) marks the
  bill paid and changes no balance / writes no movement; a **`linked`** account is marked paid but
  **never receives a manual deduction** (and no movement). **Reversal** reopens the bill to
  scheduled/due/overdue **by its due date**, atomically **credits the account back** and appends an
  equal **positive** reversal movement that references the original; the **original payment movement
  is never deleted**, and a **partial unique index on `reversal_of_id`** plus the paid-status guard
  make a **duplicate/concurrent reversal unable to credit twice** (409). **Existing/historical paid
  bills get no fabricated movement** (the ledger starts empty; reversing a pre-ledger paid bill
  reopens it with no credit). `/finances` gained a **Recent activity** ledger view, an actual-amount
  + paid-from/external **pay form**, paid-confirmation labels, and a **Reverse** action. This
  **supersedes** the Finance 1A.1 rule "marking paid never changes a balance" **for manual-account
  payments** (external/linked still change nothing). Additive migration `0006_zippy_impossible_man.sql`
  (reviewed: only `CREATE TYPE` + `CREATE TABLE` + FKs/indexes, no change to any existing table)
  applied. **No** Plaid / income splits / transfers / discretionary spending / reconciliation / AI.
  **Owner accounts/bills survived untouched**; ID-scoped cleanup; request 222 untouched; no usage log.
  Finance 1A.1 (74) / Home 1A (55) / Manage-tasks (27) / Build 2A (136) / 2B.1 (126) / 2B.2 (60)
  regress green.
- **Finance 1A.2 — income splits + account transfers**, verified **deterministically**
  (`scripts/verify-finance1a2.ts`, **62/62**, real route handlers + services vs real Neon, incl.
  **real wall-clock concurrency**) and **end-to-end through the running server** (authenticated HTTP:
  split income receive/undo + scheduled→complete→reverse transfer, SSR HTML confirmed).
  **Income** can go to one account or be **split** across several by `fixed` → `percent-of-remaining`
  → `remainder` rows; the split is computed in **integer cents** (no float drift) and always sums
  exactly to gross (remainder/last-row absorbs rounding). Scheduled income changes no balance;
  **receiving** it atomically marks it received and, per **manual** destination, credits the account
  and writes one positive `income_received` movement (linked destinations get none; **undo receipt**
  appends equal negative `income_reversal` movements and restores balances). **Transfers** between
  owned accounts: a scheduled transfer changes no balance; completing a **manual→manual** transfer
  atomically moves both balances + writes paired `transfer_out`/`transfer_in` movements (manual→linked
  deducts the source only; linked-source is rejected); **reverse** restores both and appends opposite
  movements. **Total owned cash is invariant** under an internal transfer. Duplicate/concurrent
  receipt, completion, and reversal are all single-deduction/credit (409 + status guard + the
  `reversal_of_id` unique index). `/finances` gained **Income** and **Transfers** sections + a live
  split preview; **Recent activity** now labels all bill/income/transfer movements (transfers are
  never shown as earnings or spending). **Income management moved from `/manage` to `/finances`**
  (`/manage` Money is now a summary + link). Additive migration `0007_square_marauders.sql` (reviewed:
  `CREATE TYPE`/`ALTER TYPE ADD VALUE`/`CREATE TABLE`/nullable `ADD COLUMN`/indexes — no existing
  table rewritten, `income.status` defaults to `scheduled`). **No** Plaid / bank sync / imported
  transactions / discretionary spending / reconciliation / projection / AI. **Owner data untouched**;
  ID-scoped cleanup; request 222 untouched; no usage log. Finance 1A.1 (76) / 1A.3A (70) / Home 1A
  (56) / Manage-tasks (27) / Build 2A (136) / 2B.1 (126) / 2B.2 (60) regress green.
- **Finance 1A.3B — reconciliation + projected balances**, verified **deterministically**
  (`scripts/verify-finance1a3b.ts`, **46/46**, reconciliation via real routes + services vs real
  Neon incl. concurrency; projection via the pure engine with constructed views) and **end-to-end
  through the running server** (authenticated HTTP: projection HTML across horizons + reconcile/undo).
  **Reconciliation:** the owner enters the real bank balance; the app atomically sets the manual
  actual balance, stamps `lastReconciledAt`, and appends one append-only **`reconcile_adjustment`**
  movement recording the signed delta + prior/new balance (a zero-delta only refreshes the timestamp).
  Manual accounts only (linked/inactive/foreign rejected); an optimistic balance guard makes a
  duplicate/concurrent reconcile apply at most once. **Undo** restores the prior balance + prior
  timestamp and appends a **`reconcile_reversal`** (original never deleted; double-undo blocked).
  **Projection** (pure `lib/services/finance-projection.ts`) = actual + scheduled inflows − scheduled
  outflows within a horizon (**7 days / until next payday / 30 days**, default *until next payday* with
  a 14-day fallback). It **never** overwrites actual balances and a projected figure is never called
  current/live/available/safe-to-spend. Only **scheduled** items project; paid bills, received income,
  and completed/reversed transfers are already in actual and are **never counted twice**. Unassigned
  bills/income are surfaced (never guessed into an account); linked-account items are excluded with a
  truthful warning; credit liabilities stay separate from cash; internal transfers net to zero.
  Deterministic warnings (projected shortfall, unassigned bill/income, linked-not-projected) each
  explain themselves. `/finances` gained per-account **actual vs projected** cards + a horizon
  selector + a **Forecast timeline** + a **Reconcile** panel (with adjustment preview + Undo); Home
  Money awareness now shows **Manual actual cash** + a **projected** figure + a shortfall flag (never
  "safe to spend"); `/manage` stays summary-only. Additive migration `0008_useful_vapor.sql`
  (`ALTER TYPE ADD VALUE` ×2 + 3 nullable `ADD COLUMN`; no rewrite, no backfill, no balance change).
  **No** Plaid / bank login / imported transactions / discretionary spending / recurring-bill
  materialization / AI. **Owner data untouched** (no fabricated reconciliation); ID-scoped cleanup;
  request 222 untouched; no usage log. Finance 1A.1 (68) / 1A.3A (63) / 1A.2 (72) / Home 1A (56) /
  Manage-tasks (27) / Build 2A (136) / 2B.1 (126) / 2B.2 (60) regress green.
- **Finance 1A.4 — recurring income + estimate-vs-confirmed paychecks**, verified **deterministically**
  (`scripts/verify-finance1a4.ts`, **65/65**: pure recurrence + projection, plus schedule generation/
  receipt/split/reversal/status + history-safety + individual-override preservation against real Neon)
  and **end-to-end through the running server**
  (recurring schedules → occurrences → receive-with-variance → reverse → skip; Home wording).
  A **recurring income SCHEDULE** (`income_schedules`) is the reusable payday rule; its **occurrences
  are materialized as `income_entries`** (linked by `schedule_id`) so they reuse the existing receipt/
  reversal/split/projection machinery. **Cadences:** one-time, weekly, biweekly, **twice-monthly**
  (two days, a day past month-end resolving to the last calendar day — leap-aware), monthly (incl.
  last day). **Estimate modes:** `fixed`/`typical` (use the expected amount), `range` (projection uses
  the **minimum**, conservative), `unknown` (forecasts the payday at **$0**). Every estimate is labeled
  (**Estimated / Estimated range / Amount unknown / Confirmed received**); the UI never implies
  guaranteed, payroll-certain, or bank/employer-verified income. **Generation** is bounded (a rolling
  −14…+90-day window), idempotent (existing-date check + a partial unique index), replenished on
  `/finances` + Home load — no background automation. Receiving an occurrence reuses the income ledger
  (atomic, split-aware), records the **actual amount + variance** (actual − expected, $ and %), and is
  reversible; **skip/cancel** exclude an occurrence from projection (received/paid never double-counted).
  Schedule edits regenerate only **future, still-scheduled, non-overridden** occurrences (received/
  skipped/cancelled/reversed/past **and individually-edited** occurrences are preserved — tracked by an
  explicit `is_overridden` flag + a `scheduled_for` rule-date claim so no duplicate is created on the
  original or moved date). **Removing a schedule that has any history ARCHIVES it** (soft-delete +
  pause; every occurrence + ledger movement kept and readable; no new generation); only a genuinely
  unused schedule is hard-deleted (the `income_entries.schedule_id` / `account_movements.income_id` FKs
  are `ON DELETE no action`, so the DB cannot cascade-delete occurrences or ledger history).
  **Next-payday wording is now truthful:** *Until next expected payday* only when an active
  recurring payday occurrence is next, *Until next scheduled income* for one-time/non-payroll income,
  and a deterministic 14-day fallback otherwise. Home shows next expected payday/scheduled income + an
  estimate label + an unconfirmed-income flag. Additive migrations `0009_loud_nightmare.sql`
  (`CREATE TYPE` ×2 + `ALTER TYPE ADD VALUE` + 2 `CREATE TABLE` + nullable/defaulted `ADD COLUMN`s) and
  `0010_curvy_lily_hollister.sql` (`income_entries.scheduled_for` + `is_overridden`, additive, no
  backfill); existing income stays standalone — **no auto-conversion**. **No** Plaid / bank login / imported
  transactions / payroll integration / AI. **Owner income unchanged** (still standalone); ID-scoped
  cleanup; request 222 untouched; no usage log. Finance 1A.1 (68) / 1A.3A (63) / 1A.2 (72) / 1A.3B (57)
  / Home 1A (56) / Manage-tasks (27) / Build 2A (136) / 2B.1 (126) / 2B.2 (60) regress green.
- **`npm run typecheck` and `npm run build`** pass on the current code (the build includes the
  Home `/`, `/manage`, `/finances`, the bill `pay`/`reverse` routes, the income `receive`/`reverse`
  + `transfers` + `income-schedules` routes, the account `reconcile`/`reconcile/undo` routes, and the
  `/interpret`, `/recommend`, `/select-recommendation` routes).

## 🟡 Partially implemented

- **Editing existing records** — the `PATCH` API routes accept field edits, but there is **no
  in-UI edit form**, and only the **status-change** path (complete / done / paid / dismiss)
  was exercised this session. Arbitrary-field edits (renaming, amount changes) are implemented
  but not exercised.
- **Daily briefing** — the rule-based engine (`lib/briefing.ts`) runs and renders, but the
  result is **recomputed per request and not persisted** (the `daily_briefings` table is
  unused).
- **Mock fallback** — implemented per vertical; the dashboard shows real data when the DB is
  configured and mock data otherwise, with a banner indicating which.

## ◻️ Implemented but unverified this session

- **`/experiences` DB-failure error state** — enforced by construction (the page's
  try/catch renders an explicit error and never falls back to mock experiences), but this
  failure path was **not runtime-simulated** this session.
- **Browser UI mutation flows for the original seven verticals** (tasks, obligations,
  finances, signals, opportunities, jobs, interest) — buttons call verified API paths and
  pages render, but their click-throughs were not driven in a real browser. (The
  `/experiences` workflow **was** browser-verified — see above.)
- **Triage drop-off** — completed/cancelled tasks, done obligations, and dismissed/expired
  signals/opportunities/jobs/interest items are filtered out in code, but this drop-off was
  **not visually exercised** with populated data this session.

## ⚪ Mock / placeholder

- **`lib/mock-data.ts`** supplies demo rows used only when the database is unconfigured or a
  query fails. Demo/seed rows carry a "Mock" tag / `isMock` flag.
- **Seed data** (`db/seed.ts`) inserts one labeled demo signal and job.

## 📐 Designed, not implemented

- **Recurring bills/income generation** — `recurring_bills` and recurrence fields exist; no
  instance materialization.
- **AI / automation** — **off by default.** Two owner-triggered AI features now exist in code:
  **Experience interpretation** (Build 2A, Anthropic Haiku → structured constraints) and
  **Experience recommendations** (Build 2B.1, Anthropic Sonnet → exactly three validated concept
  cards). Both are gated behind three independent switches — env `AI_AUTOMATION_ENABLED="true"`,
  a configured `ANTHROPIC_API_KEY`, **and** `intelligence_settings.aiAutomationEnabled` (with a
  `killSwitch`) — and enforced before any call by a per-op cap (interpret $0.02 / recommend
  $0.05) and a monthly ceiling (min of the $5 dev constant and the configured limit). Neither
  publishes, spends, contacts anyone, or auto-runs; the manual path always remains usable. No
  live call has been made in this environment. **Build 2B.2** (recommendation selection +
  one-action plan creation) is now implemented — the selection itself makes **no** AI call — so
  the core Experience workflow `request → interpretation → recommendations → choice → planned
  experience` is complete end to end. Still unbuilt: the scheduled function
  `netlify/functions/generate-daily-briefing.mts` does not run and makes no external/AI calls.
- **External integrations** — none (calendar, weather, news, job boards, local events).
- **The "public identity" surface** from `PRODUCT_VISION.md` — not started.
- **Schema with no UI/logic yet:** `scheduled_run_logs`, `signal_sources`,
  `opportunity_signals`, `opportunity_feedback`, `daily_briefings`. (`intelligence_settings`
  and `api_usage_logs` are now **read/written** by the Build 2A AI orchestration — enablement
  gates, cost ceiling, and bounded usage logging — but still have no settings UI.)

## Authentication (explicit)

The current authentication is a **single-owner password gate** — one shared password
(`APP_PASSWORD`) unlocks the whole app via a signed cookie. It is **not** account-based
authentication and **not** multi-user: there are no per-user accounts, sign-up, or password
reset, and **all data belongs to one hard-coded owner** (`CURRENT_USER_ID = 1` in
`lib/auth.ts`). The gate controls *access to the app*, not separation of data between users.

## ⚠️ Known risks / configuration requirements

- **Gate is off when `APP_PASSWORD` is unset.** With it unset the app is open (intended for
  local dev). It **must** be set (with `AUTH_SECRET`) before any deployment.
- **No automated tests.** All verification to date is manual; regressions can pass unnoticed.
- **Not deployed.** Runs locally only; Netlify is not linked and its env vars are not set.
- **Single point of data ownership.** Everything is under one hard-coded user; there is no
  data isolation.
- **Secrets live only in environment variables** (`.env`, gitignored). They must never be
  committed or written into docs.

## Environment variables (names only — see `.env.example`)

`DATABASE_URL`, `DEFAULT_USER_EMAIL`, `APP_PASSWORD`, `AUTH_SECRET`,
`AI_AUTOMATION_ENABLED`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`EXPERIENCE_INTERPRET_MODEL` (optional), `EXPERIENCE_RECOMMEND_MODEL` (optional).

## How to run

```
npm install
cp .env.example .env     # fill in locally; never commit
npm run db:migrate       # apply schema to DATABASE_URL
npm run db:seed          # create the single owner + demo rows
npm run dev              # http://localhost:3000
```

Checks: `npm run typecheck`, `npm run build`, `npm run lint`.
