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

### Finalize and phase the Experience and Adventure Loop v1 implementation plan

- **Status:** **Awaiting final owner review. Do not begin implementation.**

> **Scope of this approval.** The Experience and Adventure Loop **v1 specification is approved
> as the target v1 product specification.** That approval is of the *specification* — **not**
> authorization to implement the entire specification in one pass.
> - Implementation **must be broken into smaller, separately approved build stages.**
> - Claude Code may **not** implement schema, services, API, UI, AI, provider dependencies, or
>   configuration **until a specific build stage is approved.**

- **Approved specification:** [`docs/specs/EXPERIENCE_ADVENTURE_LOOP_V1.md`](specs/EXPERIENCE_ADVENTURE_LOOP_V1.md).
  - The specification document is **approved as the target v1 product specification**.
  - **Full implementation is not authorized.**
  - **Build 1** (Manual lifecycle foundation) is the **next candidate bounded implementation task**.
  - **Each build requires separate owner approval.**
- **Immediate next step:** prepare the **exact Build 1 implementation task** (scope, file list,
  acceptance criteria, plan) and present it for owner review. No code, schema, dependencies,
  configuration, or behavior changes until Build 1 is approved.

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
