# Working in this repository (for Claude Code sessions)

This repo is the **source of truth** for product and architecture — not chat history.
Treat `/docs` as authoritative. Follow this workflow.

## Before editing

1. **Read these first**, every session, before touching code:
   - `docs/PRODUCT_VISION.md` — durable, owner-approved principles (privacy, AI limits,
     publishing, build philosophy).
   - `docs/CURRENT_STATE.md` — what verifiably exists right now, by maturity.
   - `docs/DECISIONS.md` — the decision log and how each item is classified.
   - **The active task** — the "Next approved task" section of `docs/HANDOFF.md`.
   - Skim `docs/DATA_MODEL.md` and `docs/DESIGN_PRINCIPLES.md` when relevant.
2. If there is no approved task in `HANDOFF.md` for what you're being asked to do, **say so**
   and help define one before implementing — don't improvise scope.

## Product guardrails (from PRODUCT_VISION.md — non-negotiable)

- **Private by default; never auto-publish.** Do not build anything that publishes or exposes
  private information automatically. Publishing is always an explicit owner action.
- **AI assists; the owner decides.** Never implement behavior where AI automatically
  publishes, spends money, contacts people, or exposes private information.
- **Complete workflows over breadth.** Prefer finishing one end-to-end workflow over adding
  shallow features.

## While working

3. **Propose a plan before substantial changes.** For anything beyond a trivial, localized
   edit, write the approach (and the files you'll touch) into the active task in
   `HANDOFF.md` and get approval before implementing.
4. **Stay in scope.** No unrelated modifications, refactors, renames, or dependency changes
   the task didn't ask for. Flag them separately instead.
5. **Follow the engineering conventions** in `docs/DESIGN_PRINCIPLES.md` — layered
   architecture (UI → service → DB), view models, soft deletes, server-as-source-of-truth,
   and the "vertical wiring" pattern. `route.ts` files export only HTTP handlers.
6. **Never expose secrets.** Do not print, commit, or write into docs any credentials,
   tokens, personal data, or environment-variable *values*. Reference env vars by name only
   (e.g. `DATABASE_URL`). `.env` is gitignored and must stay that way.

## Testing & honesty

7. **Run the relevant checks and report results truthfully.**
   - `npm run typecheck` and `npm run build` for code changes.
   - There is **no automated test suite yet**; verify behavior with targeted manual checks
     (e.g. `curl` against affected API routes, or the dev server) and state exactly what you
     did and did not verify.
   - If something fails or is unverified, say so plainly. Never claim a change works without
     evidence.

## After implementing

8. **Update the docs in the same change:**
   - `docs/CURRENT_STATE.md` — reflect the new reality, in the right maturity bucket.
   - `docs/HANDOFF.md` — write the handoff report (use the template at the bottom) and reset
     the "Next approved task" section.
   - `docs/DECISIONS.md` — append an entry for any decision, **classified honestly**
     (owner-approved only with explicit evidence; otherwise provisional / constraint /
     observed).
9. **Report exactly which files you created or changed.**

## Git

- Commit/push only when the human asks. Keep the diff scoped to the task; descriptive message.

## Quick facts (see `docs/CURRENT_STATE.md` for the full, current picture)

- Next.js 15 (App Router) + React 19 + TypeScript; Neon Postgres + Drizzle; Netlify target.
- **Single-owner** app: all data is owned by the hard-coded user in `lib/auth.ts`. The auth
  is a **single-owner password gate**, not account-based or multi-user.
- A password gate (`middleware.ts`, `lib/session.ts`) protects the app when `APP_PASSWORD` is
  set; it is off when unset (local dev).
- All seven verticals (tasks, obligations, finances, signals, opportunities, jobs, interest)
  are wired to the database with a mock fallback.
