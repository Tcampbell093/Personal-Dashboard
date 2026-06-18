# Personal Command Center

A smart daily operations dashboard. Its job is to **triage**, not to flood you
with a feed: every day it tells you what to **act on**, what to **be aware of**,
and what to **explore** — across tasks, obligations, money, local signals,
opportunities, jobs, and interests.

This is **Phase 1: the foundation.** It renders a complete dashboard from
clearly-labeled mock data and ships the full database schema, service layer, an
example API endpoint, and a disabled scheduled-function stub. No external APIs,
no AI calls, and no money are spent yet.

---

## Technology stack

| Layer      | Choice                                   | Why |
|------------|------------------------------------------|-----|
| Framework  | Next.js 15 (App Router) + TypeScript     | SSR for fast first paint; route handlers deploy as Functions |
| Hosting    | Netlify (`@netlify/plugin-nextjs`)       | Your existing host; native Next.js support |
| Database   | Neon PostgreSQL                          | Serverless Postgres |
| DB driver  | `@neondatabase/serverless`               | HTTP driver, correct for serverless cold starts |
| ORM        | Drizzle ORM + drizzle-kit                | TypeScript-first, plain-SQL migrations, no engine binary |
| Scheduling | Netlify Scheduled Functions              | For the future daily-briefing cron |

Runtime dependencies are deliberately minimal: Next, React, Drizzle, the Neon
driver. No UI library — styling is hand-written CSS.

---

## Local setup

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL
npm run dev                 # http://localhost:3000
```

The dashboard renders immediately on **mock data** — you do **not** need a
database to see the UI. A dashed banner makes the mock state explicit.

### Type-check / lint / build

```bash
npm run typecheck
npm run lint
npm run build
```

---

## Environment variables

See `.env.example`. Never commit `.env`.

| Variable | Required in Phase 1 | Purpose |
|----------|---------------------|---------|
| `DATABASE_URL` | Only to go live | Neon pooled connection string |
| `DEFAULT_USER_EMAIL` | For seeding | Owner of all single-user rows |
| `AI_AUTOMATION_ENABLED` | No (keep `false`) | Master gate for any AI/scheduled work |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | No | Reserved for a later phase |

All secrets live in env vars and Netlify's dashboard — never in client code.

---

## Neon setup

1. Create a Neon project and a database.
2. Copy the **pooled** connection string into `DATABASE_URL`.
3. Generate and apply migrations (below).

## Database migrations

Migrations are generated as plain SQL into `db/migrations/` and committed.

```bash
npm run db:generate     # create SQL migration from db/schema.ts
npm run db:migrate      # apply migrations to DATABASE_URL
npm run db:seed         # create the single user + labeled mock rows
npm run db:studio       # optional: browse the DB
```

## Netlify setup & deployment

1. Push to GitHub and link the repo in Netlify.
2. Add `DATABASE_URL` (and later AI keys) in **Site settings → Environment
   variables**.
3. Netlify auto-detects Next.js. Build command `npm run build`, publish `.next`.
4. Deploys on every push to the default branch.

## Scheduled function (currently DISABLED)

`netlify/functions/generate-daily-briefing.mts` exists but **does not run on a
schedule.** To enable it later:

1. Uncomment the `[functions."generate-daily-briefing"]` block in
   `netlify.toml` (cron is in **UTC**).
2. Set `AI_AUTOMATION_ENABLED=true` in Netlify env vars. While it is anything
   other than `true`, the function exits immediately by design — this is the
   kill switch in action.

Even when enabled, Phase 1's function only runs the **rule-based** briefing
engine (`lib/briefing.ts`). No external/AI calls.

---

## Going live (turning off mock mode)

The dashboard reads from `lib/services/dashboard.ts`. Phase 1 returns mock data;
the real-data path is written in a comment block right below it. To switch:

1. Run migrations + seed.
2. Implement the remaining service functions following `lib/services/tasks.ts`.
3. Replace the mock block in `loadDashboard()` with the real-query block.

The UI never changes — it depends only on the `DashboardData` contract.

---

## Current limitations (be honest about these)

- **All dashboard data is mock.** Only the schema, the tasks service, and the
  `/api/tasks` endpoint touch a real database.
- No authentication. A single hard-coded `USER_ID = 1` owns everything. The
  schema is multi-user-ready; the app is not multi-user yet.
- Forms for creating/editing tasks, obligations, signals, etc. are **not built
  yet** — only the tasks API endpoint exists as the template.
- No Google Calendar, weather, news, job, or AI integrations. The schema and a
  service-layer seam are prepared for them; nothing is connected.
- Financial calculations in the scheduled function are stubbed to zero until
  `lib/services/finances.ts` is implemented.

## Planned future integrations

Google Calendar sync · weather · RSS/news ingest · job-board APIs · estate-sale
& event sources · Anthropic/OpenAI for briefing + opportunity synthesis · email
notifications. Each goes behind the intelligence kill switch and the usage
ledger (`intelligence_settings`, `api_usage_logs`).

## Recommended next phase (Phase 2)

1. **Auth + real user resolution** (replace `USER_ID = 1`).
2. **Wire one vertical end to end:** tasks. Build the create/edit/complete UI
   against the existing `/api/tasks` endpoint, then flip the dashboard's tasks
   section to real data. This proves the full stack before scaling out.
3. Repeat the tasks pattern for obligations and finances (including the real
   `computeFinancialOutlook`).
4. Build the Signal Inbox + manual "Create Opportunity" flow.
5. Only then, behind the kill switch, introduce the first AI briefing.

> Heavy iterative work on this is best done in **Claude Code**, where the repo,
> migrations, and builds can be run and committed directly.
