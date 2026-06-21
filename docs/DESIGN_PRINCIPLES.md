# Engineering Conventions

> **Implementation conventions only** — how the code is structured. Product principles
> (privacy, AI limits, publishing, build philosophy) live in `docs/PRODUCT_VISION.md` and
> are not repeated here. These conventions are **observed patterns** in the current code (see
> `docs/DECISIONS.md`), not separately-approved mandates — but follow them for consistency
> unless a task explicitly changes them.

## Conventions (verifiable in the code)

1. **Layered architecture.** `UI (app/, components/)` → `services (lib/services/*)` →
   `db (Drizzle)`. UI never touches the database directly; all DB access goes through a
   service.
2. **View models decouple UI from DB.** `lib/types.ts` defines view models; services map rows
   → view models with `to*Views()`. The UI depends only on the view-model contract.
3. **Soft deletes only.** Domain rows set `deletedAt`; never hard-deleted in app code. Queries
   filter `isNull(deletedAt)`.
4. **Mock fallback never breaks the UI.** If the DB is unconfigured or a query fails,
   `loadDashboard()` falls back to mock data so the page still renders, with a banner.
5. **Server is the source of truth.** Client islands mutate via API routes, then call
   `router.refresh()` to re-render the server component — no parallel client data store.
6. **Identity resolved server-side.** Clients never send `userId`; it is resolved in
   `lib/auth.ts`.
7. **Minimal dependencies, hand-written CSS.** No UI component library; system fonts; no
   remote fonts.

## The "vertical wiring" pattern

A new data-backed feature is added the same way every existing vertical was:

1. `lib/services/<entity>.ts` — list / create / update / delete + a `to<Entity>Views` mapper.
   Keep shared validation enums here.
2. `app/api/<entity>/route.ts` (GET/POST) + `app/api/<entity>/[id]/route.ts` (PATCH/DELETE,
   soft delete via `deletedAt`).
3. `components/<entity>.tsx` — a `"use client"` island (add form + row actions) that calls the
   API and then `router.refresh()`.
4. `lib/services/dashboard.ts` — load real data when the DB is configured, else mock; expose a
   `<entity>Live` flag on `DashboardData`.
5. `app/page.tsx` — render the form/actions, gated on the live flag.

> Next.js note: `route.ts` files may export **only** HTTP handlers. Keep shared enums/helpers
> in the service module, or `next build` / `tsc` (via `.next/types`) will error.
