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
