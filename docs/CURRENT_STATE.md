# Current State

> What is actually in the repository, classified by maturity. Keep it factual and update it
> after every substantive change (see `CLAUDE.md`). For the durable product vision, see
> `docs/PRODUCT_VISION.md`.

**Last updated:** 2026-06-23 · **Reflects branch:** `main` (Finance 1A.1 implemented, uncommitted)

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
- **`npm run typecheck` and `npm run build`** pass on the current code (the build includes the
  Home `/`, `/manage`, `/finances`, and the `/interpret`, `/recommend`, `/select-recommendation`
  routes).

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
