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

---

## Open decisions — `[DECISION NEEDED]`

Mirror of the open questions in `PRODUCT_VISION.md`; record answers here when made:

- `[DECISION NEEDED]` Definition of success / metrics.
- `[DECISION NEEDED]` First complete end-to-end workflow to build.
- `[DECISION NEEDED]` First AI-assist capability and its cost ceiling.
- `[DECISION NEEDED]` Shape of the public-identity surface.
- `[DECISION NEEDED]` If/when to adopt an automated test framework, and which.
