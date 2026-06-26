# Roadmap — candidate backlog

> **Strategist-owned.** This is a list of **possible future directions**, not approved
> implementation work. Nothing here is scheduled, prioritized, or specified.
>
> - No priorities, phases, deadlines, or technical solutions are implied. Those are added
>   only when explicitly approved by the owner and strategist.
> - **The single approved task always lives in `docs/HANDOFF.md`** — not here.
> - Durable principles live in `docs/PRODUCT_VISION.md`.

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
- **Read-only bank connections (Finance 1B)** — *in progress.* **1B.0** (provider-neutral contracts +
  security) and **1B.1** (Plaid **Sandbox** connect: encrypted `financial_connections`, link/exchange/
  list routes, `/finances` Bank-connections UI) are **done**. Bank **sync is still not functional** —
  no accounts, balances, transactions, webhooks, or matching yet; **read-only, no money movement**.
  Next: **1B.2** (accounts + cached balances), **1B.3** (incremental transaction sync + webhooks), then
  matching (bills → income incl. split deposits → transfers), manual-to-linked transition, and repair/
  disconnect hardening. Real Chase/BofA need eligible Production/OAuth (a later owner step). See
  `docs/BANK_INTEGRATION_SECURITY.md` and `docs/DECISIONS.md` ADR-027/028. (The active approved task is
  always in `docs/HANDOFF.md`.)
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
