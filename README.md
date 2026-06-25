# Xanther

**Xanther** is a private, AI-powered personal operating system and life-progression
platform. It combines practical life management, financial awareness, planning, experience
discovery, personal progression, memory, and an eventual conversational AI assistant.

This repository is an early, **single-owner** slice of that platform: a daily-operations
surface that **triages** what to act on, be aware of, and explore — across tasks,
obligations, finances, signals, opportunities, jobs, and interests.

> **Historical names.** Xanther was previously called *Personal Command Center* (and earlier
> *Personal Command Tool* / *Personal Dashboard*). Those are historical aliases only. Some
> technical identifiers — the GitHub repo name (`Personal-Dashboard`), routes, database
> tables/columns, and environment variables — deliberately retain their original names; they
> are internal, not the product identity, and are out of scope for this branding change.

> **Authoritative documentation lives in [`/docs`](docs/) and [`CLAUDE.md`](CLAUDE.md).**
> This README is a concise technical entry point. For product vision, current state, the
> data model, and decisions, read `/docs` — start with
> [`docs/PRODUCT_VISION.md`](docs/PRODUCT_VISION.md) and
> [`docs/CURRENT_STATE.md`](docs/CURRENT_STATE.md).

## Status

- All seven verticals are wired to Postgres, with a mock-data fallback when the database is
  unconfigured.
- Access is protected by a **single-owner password gate** — *not* account-based or
  multi-user authentication.
- **No automated test suite yet** — verification is via type-check, build, and manual checks.
- **Not deployed** — runs locally.

See [`docs/CURRENT_STATE.md`](docs/CURRENT_STATE.md) for a per-feature maturity breakdown.

## Stack

| Layer      | Choice                                   |
|------------|------------------------------------------|
| Framework  | Next.js 15 (App Router) + React 19 + TS  |
| Hosting    | Netlify (`@netlify/plugin-nextjs`) — target, not yet deployed |
| Database   | Neon PostgreSQL                          |
| DB driver  | `@neondatabase/serverless` (HTTP)        |
| ORM        | Drizzle ORM + drizzle-kit                |
| Auth       | Single-owner password gate (signed JWT cookie via `jose`) |

No UI library; styling is hand-written CSS.

## Local setup

```bash
npm install
cp .env.example .env        # fill in values locally; never commit .env
npm run db:migrate          # apply schema to DATABASE_URL
npm run db:seed             # create the single owner + demo rows
npm run dev                 # http://localhost:3000
```

Checks: `npm run typecheck`, `npm run build`, `npm run lint`.

## Authentication

The whole app is gated when `APP_PASSWORD` is set (requires `AUTH_SECRET`): unauthenticated
page requests redirect to `/login`; API requests get `401`. With `APP_PASSWORD` **unset the
gate is off** (local dev only) — set it before deploying anywhere public.

This is a single shared-password gate for **one owner**. It is not account-based or
multi-user authentication, and all data belongs to a single hard-coded owner
(`lib/auth.ts`). See [`docs/DECISIONS.md`](docs/DECISIONS.md) (ADR-007).

## Environment variables

See [`.env.example`](.env.example) for the full list and notes. Names only:
`DATABASE_URL`, `DEFAULT_USER_EMAIL`, `APP_PASSWORD`, `AUTH_SECRET`,
`AI_AUTOMATION_ENABLED`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`. Never commit `.env`.

## Database

Schema lives in `db/schema.ts`; migrations are committed under `db/migrations/`. See
[`docs/DATA_MODEL.md`](docs/DATA_MODEL.md).

```bash
npm run db:generate     # generate a SQL migration from schema changes
npm run db:migrate      # apply migrations
npm run db:studio       # browse the database
```

## Scheduled function (disabled)

`netlify/functions/generate-daily-briefing.mts` exists but does **not** run on a schedule and
makes no AI/external calls. AI and automation are off by default; the guardrails governing any
future AI work are in [`docs/PRODUCT_VISION.md`](docs/PRODUCT_VISION.md).

## Documentation map

- [`docs/PRODUCT_VISION.md`](docs/PRODUCT_VISION.md) — durable, owner-approved product principles
- [`docs/CURRENT_STATE.md`](docs/CURRENT_STATE.md) — what exists, by maturity
- [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) — schema summary
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — classified decision log
- [`docs/DESIGN_PRINCIPLES.md`](docs/DESIGN_PRINCIPLES.md) — engineering conventions
- [`docs/HANDOFF.md`](docs/HANDOFF.md) — next approved task + latest handoff
- [`CLAUDE.md`](CLAUDE.md) — how implementation sessions should work
