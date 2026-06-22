# Product Vision

> **Durable, owner-approved product principles.** This is the authoritative statement of
> what we are building and the rules that govern it. It is **not** derived from the README
> and it is **not** a description of current implementation status (for that, see
> `docs/CURRENT_STATE.md`). Principles here are settled unless explicitly changed by the
> owner and recorded in `docs/DECISIONS.md`.

## What this is

Personal Command Center is a **private, AI-powered personal operating system** for the
owner, paired with a **separately controlled public identity**.

- The **private system** is where the owner's information, decisions, finances, and daily
  operations live. It is for the owner.
- The **public identity** is a distinct, deliberately curated surface. What becomes public
  is chosen by the owner and is never an automatic reflection of the private system.

These two are **separately controlled**. The boundary between them is a core feature, not
an afterthought.

## Core principles (owner-approved)

### Privacy & control
1. **Private by default.** New personal information is private unless the owner decides
   otherwise.
2. **No automatic publishing.** Private information must never be published automatically.
3. **Deliberate publishing only.** Public content requires explicit owner selection and
   approval. Publishing is always an intentional owner act.
4. **Separation of surfaces.** The private system and the public identity are controlled
   independently.

### AI's role and its limits
5. **AI assists; the owner decides.** AI may summarize, classify, surface connections, and
   make recommendations. It proposes — it does not decide.
6. **AI must never automatically:** publish content, spend money, contact people, or expose
   private information. Any such action requires explicit owner approval.
7. **Recommendations are explained.** AI recommendations should explain *why* they fit the
   owner's goals, preferences, constraints, and history — not just *what* is recommended.
8. **The system learns from outcomes.** It should improve from signals the owner provides:
   accepted, rejected, completed, rated, and reflected-on outcomes.

### Build philosophy
9. **Complete workflows over breadth.** Complete, end-to-end workflows take priority over
   decorative features or a wide surface of half-built ones.
10. **Low-friction capture.** Where appropriate, prioritize low-friction conversational or
    voice-friendly capture so getting information in is effortless.
11. **Structured, inspectable memory.** Important personal knowledge must be stored as
    structured, inspectable, editable data. **Chat history alone is not permanent memory.**

### Interfaces
12. **Device-independent core, device-appropriate interfaces.** The core is independent of any
    one device; each interface should suit the device it runs on.
13. **VR/immersive is a north star, not current scope.** Immersive and VR interfaces are a
    future north-star experience, not current implementation scope.
13a. **Visual identity is part of the product, not decoration.** The private system should feel
    like a dark, immersive personal command center — calm, futuristic, emotionally engaging, and
    subtly gamified — that reads as the owner's private world rather than a corporate dashboard.
    The visual north star is "Life OS Dashboard" *in feel only*: we create an **original** design
    system and never copy its branding, artwork, written content, or layouts. The detailed system
    lives in `docs/DESIGN_SYSTEM.md`.
13b. **Emotion supports function.** Atmosphere, progress, and achievement cues exist to help the
    owner orient and stay engaged — never at the expense of clarity, accessibility, privacy/
    provenance cues, or low-friction capture.

### Collaboration & source of truth
14. **Roles.**
    - **Owner (human)** — sets vision, makes decisions, approves all publishing and any
      consequential action.
    - **ChatGPT** — product strategist, requirements designer, reviewer.
    - **Claude Code** — implementation engineer.
15. **GitHub + `/docs` are the shared source of truth.** Chat history is not authoritative;
    requirements and decisions must be recorded in the repository.

### Scope boundary
16. **Family / multi-generational archive is a future possibility, not current scope.** Do
    not design or build for multi-user or family use now.

## Relationship to the current implementation

What exists today is an **early slice of the private system**: a single-owner triage
dashboard covering tasks, obligations, finances, signals, opportunities, jobs, and
interests. The separately controlled **public identity**, the **AI assistance** described
above, and most end-to-end workflows are **not yet built**. See `docs/CURRENT_STATE.md` for
exactly what exists and at what maturity.

## Genuinely open questions — `[DECISION NEEDED]`

Only items **not** already settled by the principles above:

- `[DECISION NEEDED]` **Definition of success / metrics** — what outcomes make this
  valuable (e.g. nothing missed, opportunities captured, time saved)?
- `[DECISION NEEDED]` **First complete workflow** — given the build philosophy, which single
  end-to-end workflow is built first? (Leading candidate: the Experience and Adventure Loop —
  see `docs/HANDOFF.md` and `docs/ROADMAP.md`.)
- `[DECISION NEEDED]` **First AI-assist capability + cost ceiling** — which assistive
  capability to introduce first, and the spending limit for it. (AI stays owner-gated per
  principles 5–8 regardless.)
- `[DECISION NEEDED]` **Shape of the public identity** — what the curated public surface is
  and where it lives, beyond the principle that it is owner-curated and separate.
