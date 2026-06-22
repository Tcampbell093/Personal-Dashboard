# Current State

> What is actually in the repository, classified by maturity. Keep it factual and update it
> after every substantive change (see `CLAUDE.md`). For the durable product vision, see
> `docs/PRODUCT_VISION.md`.

**Last updated:** 2026-06-22 · **Reflects branch:** `main`

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
- **`npm run typecheck` and `npm run build`** pass on the current code (the build includes the
  new `/api/experience-requests/[id]/interpret` route).

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
- **AI / automation** — **off by default.** One AI feature now exists in code: owner-triggered
  **Experience interpretation** (Build 2A) turning a request's free text into structured
  constraints via Anthropic Haiku. It is gated behind three independent switches — env
  `AI_AUTOMATION_ENABLED="true"`, a configured `ANTHROPIC_API_KEY`, **and**
  `intelligence_settings.aiAutomationEnabled` (with a `killSwitch`) — and is enforced before
  any call by a per-op cap and a monthly ceiling (min of the $5 dev constant and the
  configured limit). It never publishes, spends, contacts anyone, or auto-runs; the manual
  path always remains usable. No live call has been made in this environment. Everything
  else AI/automation remains unbuilt: the scheduled function
  `netlify/functions/generate-daily-briefing.mts` does not run and makes no external/AI calls;
  Build 2B (recommendations) is designed only.
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
