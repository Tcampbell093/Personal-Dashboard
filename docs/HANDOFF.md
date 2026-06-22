# Handoff

> This file holds **two things**: (1) the single **next approved bounded task** an
> implementer should pick up, and (2) the **latest handoff report** for the most recently
> completed work. It is the single location for the active task — there is no separate
> task-tracker. Durable principles live in `docs/PRODUCT_VISION.md`; candidate future
> directions live in `docs/ROADMAP.md`.
>
> **Never paste secrets, credentials, personal data, or environment-variable values here.**

---

## Next approved task

**None.** Build 2A is implemented and awaiting owner review (see the latest handoff below).
No further implementation is authorized until the owner reviews Build 2A.

After Build 2A is reviewed/approved, the next bounded task to prepare is **Build 2B — Sonnet
recommendations + one-action plan creation**, which remains **separately gated** and must not
be started without explicit approval. Build 2A deliberately stops at interpretation and does
**not** yet generate a plan; Build 2B completes the primary workflow.

> **Status note (verbatim, required while no live key is configured):** "Anthropic adapter
> implemented and deterministically verified; live Anthropic invocation pending owner
> configuration."


### Proposed implementation breakdown (phased)

Each build is a **separate approval gate.** Do not start a build until the owner approves that
specific build. Builds are ordered so the manual loop works end-to-end before any AI exists.

**Build 1 — Manual lifecycle foundation** *(no AI, no providers)*
- dedicated `/experiences` page
- schema for `experience_requests` and `experiences`
- service layer and API routes
- manual request entry
- manual constraint editing
- manual plan creation
- planned experiences
- outcome resolution
- private history
- Adventure XP
- no AI
- no provider dependencies
- no rule-based recommendation catalog unless absolutely needed for the manual loop

**Build 2 — Rule-based fallback recommendations** *(no AI provider)*
- local recommendation concept catalog
- fallback recommendation generation from confirmed constraints
- selection and plan creation from fallback recommendations
- no AI provider yet

**Build 3 — AI provider/model proposal** *(proposal only — no implementation until approved)*
- provider
- model
- structured-output approach
- cost estimates
- environment variables
- dependency impact
- privacy and retention considerations
- enforcement of the $5 monthly development ceiling
- no implementation until approved

**Build 4 — AI interpretation and AI recommendations**
- provider-adapter implementation
- owner-triggered interpretation
- owner-triggered recommendation generation
- usage logging
- cost-limit enforcement
- malformed-output handling
- manual and fallback paths remain usable

---

## Latest handoff

### Build 2A — AI infrastructure + Haiku interpretation — implemented — 2026-06-22

**Task Completed**
Implemented Build 2A exactly to the approved scope: an application-owned AI provider boundary +
owner-triggered Anthropic Haiku interpretation of an Experience request's free text into
structured constraints, with cost/privacy gates and a low-friction UX. AI is **off by default**;
no live Anthropic call was made. Not committed — awaiting owner review.

> **Anthropic adapter implemented and deterministically verified; live Anthropic invocation
> pending owner configuration.**

**Files Changed**
- AI layer (new): `lib/ai/models.ts` (model ids + pricing), `lib/ai/provider.ts` (interface,
  `AiError`, usage/result types), `lib/ai/interpretation-schema.ts` (json-schema + validator),
  `lib/ai/cost.ts` (per-op caps + monthly ceiling + spend sum), `lib/ai/anthropic-adapter.ts`
  (the only SDK importer), `lib/ai/fake-provider.ts` (verification-only), `lib/ai/provider-factory.ts`
  (server-only resolver; never returns the fake).
- Orchestration (new): `lib/services/ai-experience.ts` (gates → cost → provider → persist →
  bounded usage log; sole provider caller; provider injectable only for tests).
- Service: `lib/services/experience-requests.ts` (+`applyInterpretation`, `interpretationSummary`,
  `INTERPRETED_CONSTRAINT_FIELDS`; `toRequestView` now carries `interpretationSource`).
- API: `app/api/experience-requests/[id]/interpret/route.ts` (new POST); `[id]/route.ts` PATCH
  now clears AI provenance when an interpreted constraint is edited.
- Schema/migration: `db/schema.ts` (`experience_interpretation_source` enum, `interpreted`
  status value, three provenance columns); migration `0002_chief_natasha_romanoff.sql`
  (+ snapshot/journal), additive.
- Types: `lib/types.ts` (`ExperienceRequestStatus` + `interpreted`, `ExperienceInterpretationSource`,
  `ExperienceRequestView.interpretationSource`).
- UI: `app/experiences/page.tsx` (reorganized — "Plan a request" area, server-side `aiAvailable`
  hint, "Review details" disclosure, privacy banner); `components/experiences/request-form.tsx`
  (primary "Help me plan this" + "Start manually" fallback); `components/experiences/interpretation-summary.tsx`
  (new — provenance badge + summary + interpret/re-interpret); labeled "Cancel"/"Edit"/"Delete"
  in `plan-form.tsx`, `outcome-form.tsx`, `planned-list.tsx`; `app/globals.css` (`.btn-secondary`,
  `.exp-interp`, `.exp-disclosure`, primary textarea).
- Config/scripts: `.env.example` (model-name overrides + enablement note, names only);
  `scripts/verify-build2a.ts` (deterministic harness, committed).
- Dependency: `@anthropic-ai/sdk`.
- Docs: `docs/CURRENT_STATE.md`, `docs/DATA_MODEL.md`, `docs/DECISIONS.md` (ADR-011/012/013),
  this file.

**Database Changes**
Migration `0002_chief_natasha_romanoff` applied to Neon: added the
`experience_interpretation_source` enum, the `interpreted` value to
`experience_request_status`, and `interpretation_source` (not null, default `manual`),
`interpretation_provider`, `interpretation_model` columns on `experience_requests`. Additive
only; no existing columns altered or dropped.

**Current Behavior**
On `/experiences`, the natural-language request is the primary action. "Help me plan this"
creates the request and, **only when AI is fully enabled**, interprets it into constraints
(status → `interpreted`) with an AI/manual provenance badge and a deterministic summary;
"Start manually" creates a draft with no AI. Editing any interpreted constraint reverts
provenance to `manual`; editing only the request text does not. Constraints live under a
"Review details" disclosure; the Build 1 manual loop (plan, planned list, resolve, correct,
history, XP, planned-delete recovery) is unchanged. **AI is gated behind three switches**
(`AI_AUTOMATION_ENABLED`, `ANTHROPIC_API_KEY`, `intelligence_settings.aiAutomationEnabled` +
kill switch) and a cost ceiling (≤$0.02/interpret, ≤ min($5, configured) per UTC month); any
failure leaves manual planning fully usable.

**Testing Completed**
`npm run typecheck` ✓; `npm run build` ✓ (includes the new interpret route).
**Deterministic suite** `npx tsx --env-file=.env scripts/verify-build2a.ts` — **125/125 pass**
(**26 pure unit + 99 database-backed**), no live key, no Anthropic call. **Cleanup is strictly
ID-scoped** — the harness tracks every request id and usage-log id it creates (plus the seeded
budget row) and deletes only those by id; it issues no owner-/provider-/operation-/table-wide
delete, and restores `intelligence_settings` to the exact prior row. A **sentinel safety check**
seeds three unrelated owner records (a live interpreted request, a soft-deleted request, and a
real `anthropic` interpret usage log) and asserts all three survive a full run unchanged before
removing only those sentinels. (A safety-review pass found and fixed one untracked
Scenario-2 interpret log; the run now reports 12/12 usage-log ids created/deleted and an
independent re-query shows 0 requests / 0 usage logs / settings `ai=false,kill=false,limit=10.00`.)
- *Unit (no DB):* output validation (shape/enum/range/date → `invalid_ai_output`), pricing/cost
  math, budget gate (`per_op_limit`, `budget_exceeded`, configured-limit-wins), the fake
  provider's four scenarios, and the factory (no key → `ai_unavailable`; with key →
  `AnthropicProvider`; never the fake).
- *Database-backed (real orchestration + real PATCH route, fake provider, Neon):* **(1)**
  success persists constraints + status `interpreted` + source `ai`/provider/model, returns the
  deterministic summary, and writes exactly one success usage row whose tokens/cost match the
  fake and contains no request text/raw output; **(2)** editing an interpreted constraint via
  the real route flips source→`manual` (provider/model null, status stays `interpreted`, no AI
  log), while a `requestText`-only edit leaves provenance intact and writes no AI log; **(3)**
  provider failure leaves the request unchanged, one bounded `provider_unavailable` failure row,
  provider called once (no retry); **(4)** malformed and validation-failing output each leave
  the request unchanged with a bounded `invalid_ai_output` row that records the incurred fake
  token usage and no raw output; **(5)** all six pre-invocation blocks (env gate, DB gate, kill
  switch, missing key, per-op cap, monthly ceiling — the last seeded with $5 of `anthropic`
  spend) reject **before any provider call** (`provider NOT called`) with a zero-cost,
  null-token bounded failure row. **(6) Cleanup:** 11 temp requests hard-deleted, 13 interpret
  usage rows removed (incl. the seed + a stray earlier browser-test row), `intelligence_settings`
  restored to its prior row exactly. Independently re-queried afterward: **0 live requests, 0
  total request rows, 0 usage-log rows** for the owner; settings back to `ai=false`,
  `kill=false`, `monthly_cost_limit=10.00`. **No request text or raw provider output appeared in
  any log** (asserted per row).
**Browser (AI off)** via preview, desktop + mobile (375px): disabled "Help me plan this" +
off-note, "Start manually" creates a draft into "Plan a request", "Review details" expands the
full constraint editor, and `POST …/interpret` returns **503 `ai_unavailable`** with the request
left `draft`/`manual` — no provider call.
**Browser (fake-seeded interpreted state)** — one request was interpreted server-side via the
fake provider (settings temporarily enabled then restored; no Anthropic call), then viewed at
desktop + 375px: the NL request, the **"Interpreted by AI"** badge, the deterministic summary,
and the populated constraints under **Review details** all render, with the manual "Create a
plan" path and **no Recommendations section**. Editing the budget constraint through the real
browser UI persisted the new value, flipped the badge to **"Manually adjusted"**, cleared
`interpretation_provider`/`model` to null (DB-confirmed), kept status `interpreted`, and created
**no new usage-log row** — proving provenance-clearing with no AI call. `requestText`-only
editing is **not exposed** in the current UI (the request text is shown read-only); that path's
provenance-preservation is proven by the DB-backed Scenario 2a instead. The temporary request +
its fake interpret log were removed by id afterward. **Build 1 regression** re-exercised via API.
**`npm run lint` not run** — `next lint` only offers interactive ESLint setup (unconfigured in
this repo), as in prior builds. **No live Anthropic call was made** (per owner instruction).

**Known Issues / Not Tested**
- The only unverified behavior is a **live Anthropic call** — the adapter's actual network
  request/response against the real model. Everything downstream of the provider boundary
  (interpretation → validation → persistence → provenance `ai` → bounded logging, and the
  `ai → manual` provenance flip on a real AI-sourced DB row) **is** exercised end-to-end against
  Neon using the deterministic fake provider. A live smoke test runs only when the owner
  intentionally configures a key and flips the enablement gates.
- `/experiences` DB-failure error state remains enforced-by-construction, not runtime-simulated.

**Decisions Needed**
Owner review/approval of Build 2A before commit, and a separate decision to authorize **Build
2B** (recommendations + plan creation). See `DECISIONS.md` ADR-011/012/013.

**Recommended Next Step**
Owner reviews Build 2A and, if approved, authorizes the commit; then the Build 2B bounded task
can be prepared. Live interpretation can be smoke-tested whenever the owner intentionally
provides a key and flips the enablement gates.

### Build 1 — Manual Lifecycle Foundation — implemented — 2026-06-21

**Task Completed**
Implemented the Build 1 manual lifecycle of the Experience and Adventure Loop on a dedicated
`/experiences` page, exactly to the approved bounded scope. No AI, providers, recommendations,
or excluded features. Not committed — awaiting owner review.

**Files Changed**
- Schema/migration: `db/schema.ts` (4 enums + `experience_requests` + `experiences`);
  migration `0001_sour_kate_bishop.sql` (+ `db/migrations/meta/0001_snapshot.json`, `_journal.json`).
- Types: `lib/types.ts` (`ExperienceRequestView`, `ExperienceView`, `ExperienceXpSummary`, enums).
- Services: `lib/services/experience-requests.ts`, `lib/services/experiences.ts`.
- API: `app/api/experience-requests/route.ts`, `app/api/experience-requests/[id]/route.ts`,
  `app/api/experiences/route.ts`, `app/api/experiences/[id]/route.ts`,
  `app/api/experiences/[id]/resolve/route.ts`, `app/api/experiences/[id]/outcome/route.ts`.
- Page/components: `app/experiences/page.tsx`; `components/experiences/{request-form,
  constraint-editor,plan-form,planned-list,outcome-form}.tsx`.
- Nav/styles: `app/page.tsx` (one `/experiences` top-bar link); `app/globals.css` (scoped styles).
- Docs: `docs/CURRENT_STATE.md`, `docs/DATA_MODEL.md`, `docs/DECISIONS.md` (ADR-009 duplicate
  guard, ADR-010 delete-recovery), this file.
- (Local only, gitignored — not part of the commit: `.claude/launch.json` for the preview tool.)

**Database Changes**
Migration `0001_sour_kate_bishop` applied to Neon: 4 enums + 2 tables + FKs + indexes
(incl. a partial unique index on `experiences.request_id` where `deleted_at is null`). No
changes to existing tables.

**Current Behavior**
`/experiences` (behind the auth gate) supports the full manual loop: capture a request, edit
constraints (home-area prefilled, editable), create a plan, list planned, resolve one-way to
completed/cancelled/not_completed, correct outcome details afterward, view private history and
total Adventure XP. XP is server-computed (10/15/0). A top-bar link points to it.

**Post-implementation correction (2026-06-22):** browser testing found that optional enum
selects left at "—" submitted `""`, which the API rejected (`500`/`400`). Fixed by normalizing
empty-string enum input to `null` in the four affected routes (`experience-requests` POST/PATCH,
`experiences` POST/PATCH). Also added the request-recovery-on-delete behavior (ADR-010).

**Testing Completed**
`npm run typecheck` ✓; `npm run build` ✓. **Manual API lifecycle** (~30 assertions) — all pass —
covering request CRUD + validation, home-area isolation (DB-confirmed), duplicate-plan 409,
manual plan, edit-while-planned, one-way resolution, post-resolution correction, XP 10/15/0 +
meaningful recalculation (10↔15), resolved-cannot-revert, resolved-status-cannot-change, invalid
rating / negative amounts rejected, client `userId`/`adventureXp` ignored, non-owned → 404, and
**delete-recovery** (planned-delete → request `draft`; resolved-delete → stays `planned`).
**Enum-normalization tests** across all four routes: `""`→null (no 500), omitted-PATCH→unchanged,
valid→accepted, invalid-nonempty→400. **Full browser click-through (20-step pass)** via the
preview browser: nav link → request → prefill + home-area isolation → constraints saved with
selects at "—" → plan created with difficulty "—" → refresh persistence → edit → complete (XP 10)
→ meaningful 10↔15 → cancel/not-completed (0) → planned-delete recovery → resolved status not
editable in UI → mobile (375px) layout → no mock data. All test data cleared afterward
(`experience_requests=0`, `experiences=0`).

**Known Issues / Not Tested**
- `/experiences` DB-failure error state is enforced by construction but was **not
  runtime-simulated** (would require breaking the live DB connection).
- Browser click-throughs for the **original seven verticals** were not driven in a real browser
  (the `/experiences` workflow was). 
- `npm run lint` is **not runnable** — `next lint` launches an interactive ESLint setup that
  was never configured in this repo; no lint was performed (unchanged from prior builds).
- Deferred UX (non-blocking): the combined constraints+plan card is long/busy; the form `✕`
  cancel control has `title`/`aria-label="Cancel"` but no visible label.

**Decisions Needed**
Owner review/approval of this implementation before commit. Builds 2–4 remain gated; AI needs
the spec §18 provider/model proposal.

**Recommended Next Step**
Owner reviews and, if approved, authorizes the commit. Then Build 2 (rule-based fallback) can
be scoped.

### Experience and Adventure Loop v1 — plan phased — 2026-06-21

**Task Completed**
Recorded that the Experience and Adventure Loop **v1 specification is approved as the target
product spec**, while making explicit that full implementation is **not** authorized. Updated
the active-task title to "Finalize and phase the Experience and Adventure Loop v1
implementation plan," kept its status as awaiting review / do-not-implement, and added the
phased Build 1–4 breakdown above. **Documentation only.**

**Files Changed**
- `docs/specs/EXPERIENCE_ADVENTURE_LOOP_V1.md` — the approved v1 specification. Now holds the
  **authoritative final specification text supplied by the owner** (it replaced an earlier
  in-thread-authored draft).
- `docs/HANDOFF.md` — this file (active-task title/note → direct spec reference; phased
  breakdown retained).

**Database Changes**
None.

**Current Behavior**
Unchanged. Documentation only.

**Testing Completed**
None required — no code paths altered. Repo scanned to confirm no secrets/personal data added.

**Known Issues**
None — the authoritative final specification text now replaces the earlier draft. Per the spec's
§18, AI implementation additionally requires a separately approved provider/model proposal.

**Decisions Needed**
Owner approval of the **Build 1** implementation task (to be prepared next).

**Recommended Next Step**
Prepare the exact **Build 1 — Manual lifecycle foundation** implementation task (scope, file
list, acceptance criteria) for owner review. No implementation until approved.

### Documentation reconciliation — 2026-06-21

**Task Completed**
Reconciled the `/docs` knowledge base and `CLAUDE.md` so the repository is the authoritative
bridge between product strategy and implementation. Rewrote `PRODUCT_VISION.md` around the
owner's approved vision, restructured `CURRENT_STATE.md` by maturity, reclassified the
retroactive decisions, updated the root `README.md`, made `ROADMAP.md` a thin strategist-owned
candidate backlog, removed the separate `docs/tasks/` tracker, and recorded the leading
first-workflow candidate. **No application-code, schema, dependency, configuration, UI, or
behavior changes.**

**Files Changed** — `README.md`; `docs/PRODUCT_VISION.md`; `docs/CURRENT_STATE.md`;
`docs/DECISIONS.md`; `docs/DESIGN_PRINCIPLES.md` (trimmed); `docs/ROADMAP.md`;
`docs/HANDOFF.md`; `CLAUDE.md`. Removed: `docs/tasks/` (directory deleted).
**Database Changes** — None. **Current Behavior** — Unchanged.
**Testing Completed** — Docs-only; repo scanned for secrets/personal data.
**Known Issues** — None outstanding for the documentation set.
**Decisions Needed** — The `[DECISION NEEDED]` items in `PRODUCT_VISION.md` / `DECISIONS.md`.
**Recommended Next Step** — Define the first end-to-end workflow's scope for approval.

---

## Handoff report template

> Copy this when completing the next task; add a new entry at the top of "Latest handoff."

**Task Completed** — what was asked vs. what was done.
**Files Changed** — created/modified/deleted, with a few words each.
**Database Changes** — migrations/schema changes, or "none." No connection strings or values.
**Current Behavior** — observable behavior now, not implementation detail.
**Testing Completed** — exactly what was verified and how (`typecheck`, `build`, manual API
checks with endpoints + expected results); state honestly what was NOT tested.
**Known Issues** — remaining bugs/rough edges, or "none observed."
**Decisions Needed** — anything blocked on the owner; cross-reference `DECISIONS.md`.
**Recommended Next Step** — the single most sensible next action, and why.
