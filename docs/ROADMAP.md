# Roadmap — candidate backlog

> **Strategist-owned.** This is a list of **possible future directions**, not approved
> implementation work. Nothing here is scheduled, prioritized, or specified.
>
> - No priorities, phases, deadlines, or technical solutions are implied. Those are added
>   only when explicitly approved by the owner and strategist.
> - **The single approved task always lives in `docs/HANDOFF.md`** — not here.
> - Durable principles live in `docs/PRODUCT_VISION.md`.
> - **Approved product direction lives in `docs/PRODUCT_ALIGNMENT.md`** — Xanther's mission as a life
>   strategist, the five permanent functions (Reality, Risk, Advantage, Decision, Execution), the
>   recommendation lifecycle, the Daily Command Center vision, and the strategic sequence. Candidate items
>   below should serve those functions and pass the feature-approval test in that document.
> - **The first Daily Command Center / Personal Advantage Loop is specified in
>   `docs/DAILY_COMMAND_CENTER_SPEC.md`** (documentation-only design; implementation slices proposed there
>   are not yet approved).

## Candidate areas (unordered)

- **Xanther conversational assistant** *(documented only — not implemented; no code, voice
  libraries, dependencies, AI calls, or data models exist for it yet)* — the future
  conversational layer that **operates over the existing Xanther workflows rather than
  replacing them**. "Xanther" names both the Life OS and this future assistant. It would let
  the owner make requests such as *"Xanther, what needs my attention this week?"*, *"Xanther,
  check my finances."*, *"Xanther, what do I have planned?"*, *"Xanther, what can I do this
  weekend?"*, *"Xanther, add this as a task."*, and *"Xanther, help me understand my
  progress."* Recorded future architecture: typed conversational input; push-to-talk input;
  speech-to-text; optional spoken responses; intent and tool routing; permissioned access to
  Xanther modules; confirmation before consequential actions; bounded personal-memory
  retrieval; privacy controls; cost controls; audit history; and a typed fallback when voice
  is unavailable. A custom wake phrase such as *"Hey, Xanther"* is a **long-term
  native-device** capability, **not** a requirement for the current Netlify web app. This
  stays within existing guardrails: AI assists, the owner decides; nothing publishes, spends,
  contacts people, or exposes private information without explicit owner approval.
- **Read-only bank connections (Finance 1B)** — *in progress.* **1B.0** (contracts + security), **1B.1**
  (Plaid **Sandbox** connect), and **1B.2** (Sandbox **accounts + cached balances** + create-linked-
  account: `provider_accounts`, sync/list/create routes, linked-account display) and **1B.3A** (manual
  **transaction import** — read-only bank evidence in `imported_transactions` + an Imported activity
  section, separate from the manual ledger) and **1B.3A.1** (Imported-activity usability — 10-row
  default + Show more/less + Account/Status/Date filters — and verification-harness cleanup hardening)
  and **1B.3B** (verified Plaid webhooks → automatic transaction sync: a public, signature-verified
  `/api/webhooks/plaid`, durable idempotent `plaid_webhook_events`, durable background processing (Netlify
  Background Function + access-control secret + enabled scheduled drainer) reusing the existing sync,
  manual button retained) are **done** (committed `3f7e617`; live + verified end-to-end). **1B.4A**
  (**deterministic transaction-matching SUGGESTIONS** — bill/income/transfer-pair, 0–100 score +
  confidence + reason codes, manual *Find matches*, owner Confirm/Reject reusing the existing
  bill/income workflows) is **done** (production-verified). **1B.4B** (**evidence-only confirmation** for
  **linked-account income receipts** + **linked→linked transfer pairs** — imported transactions PROVE the
  event with **no** movement/balance/provider-snapshot/cursor change; `financial_event_evidence` +
  `income_status.received_evidence`; mixed linked/manual transfers fail closed; manual→manual keeps the
  existing workflow) is **done** (production-verified). **1B.5A** (**transaction categories +
  owner-approved merchant rules** — owner-editable categories, descriptive-only assignments, deterministic
  suggestions, explicit suggest/auto merchant rules with optional bounded apply-to-existing; categorization
  mutates no bank evidence/balance/movement/cursor and moves no money; no automatic learning) is **done**
  (implemented, uncommitted; `scripts/verify-finance1b5a.ts` 108/108). **1B.5B** (**spending insights +
  financial opportunity detection** — explainable, **read-only** deterministic insights (category/merchant
  totals + change, recurring, fee, unusual, concentration, uncategorized gap) and conservative opportunity
  cards, each separating observed fact / calculation / inferred opportunity / estimated upside /
  confidence / limitation; calculated view + minimal dismissal persistence only; changes no
  transaction/balance/movement/cursor/evidence and moves no money) is **done** (implemented, uncommitted;
  `scripts/verify-finance1b5b.ts` 108/108). **1C.0A** (**manual credit profile + financial-health
  baseline** — owner-entered score snapshots, revolving/installment accounts, collections, late payments,
  hard/soft inquiries, credit goals → deterministic utilization, credit-history/collections summaries, 12
  observations, 10 prioritized action cards, six-section health summary; **read-only, no bureau/Credit-
  Karma connection, no dispute/settlement/application automation, no money movement, no guaranteed
  score claims**; verify-first collection warnings; cash-flow-aware but never spends; Personal Advantage
  Engine output shape prepared) is **done — reviewed, merged to `main` (commit `ca4fcdb`), locally
  production-build verified, and expected to auto-deploy** (`scripts/verify-finance1c0a.ts` 127/127 after
  review fixes; live production commit/UI verification unconfirmed due to the Netlify site-level password
  and unavailable deploy-status API). **No AI, no money movement, Sandbox-only, owner-confirmed.** Next:
  the **Personal Advantage Engine** (not yet approved — do not begin),
  **budgets/goals/forecasts**, the **manual→linked authority-handoff** transition (deferred
  from 1B.2), reversal of evidence confirmations, mixed linked/manual transfer support, and
  repair/disconnect hardening. Real Chase/BofA
  need eligible Production/OAuth (a later owner step). See
  `docs/BANK_INTEGRATION_SECURITY.md` and `docs/DECISIONS.md` ADR-027/028/029/030. (The active approved
  task is always in `docs/HANDOFF.md`.)
- **Personal knowledge and editable memory** — structured, inspectable, editable personal data.
- **Experience and Adventure Loop** — capturing and acting on experiences/adventures.
- **AI recommendation foundation** — the basis for owner-gated, explainable recommendations.
- **Financial decision support** — assistance with money decisions (owner decides).
- **Project and opportunity evaluation** — weighing projects and opportunities.
- **Controlled public identity** — the separately controlled, owner-curated public surface.
- **Cross-device interfaces** — device-appropriate access to a device-independent core.
- **Future immersive / VR interface** — a north-star experience.

## Future exploration only

- **Family / multi-generational archive** — explicitly out of current scope; future
  exploration only.
