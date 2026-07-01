# Product Alignment

> **Approved product direction (source of truth).** This document defines *what Xanther is for*
> and the operating model every module and future feature must serve. It sits alongside
> `docs/PRODUCT_VISION.md` (durable principles), `docs/CURRENT_STATE.md` (what verifiably exists),
> `docs/DECISIONS.md` (the decision log), and `docs/ROADMAP.md` (candidate directions). Where this
> document and PRODUCT_VISION overlap, they are intended to agree; PRODUCT_VISION remains the
> authoritative statement of durable principles, and this document is the approved *alignment* that
> orients current and future work. Changes here are owner-approved and recorded in `docs/DECISIONS.md`.
>
> **This is a documentation-only alignment.** It approves no implementation. No feature, schema,
> route, dependency, AI integration, or UI is authorized by this document.

---

## 1. Xanther's mission

**Xanther is a private personal operating system and life strategist.**

It is **not** merely:

- a dashboard;
- a tracker;
- a collection of modules;
- or a chatbot attached to personal data.

Its purpose is to help the owner **understand their life, improve their position, and build greater
freedom** — without losing the relationships, experiences, and values that make that freedom
worthwhile.

Xanther should help the owner:

- understand what is happening;
- organize important information;
- recognize risks before they become emergencies;
- identify opportunities and leverage;
- compare options and tradeoffs;
- turn goals into practical actions;
- follow through;
- evaluate outcomes;
- learn from decisions over time.

---

## 2. Permanent operating functions

Xanther has **five permanent functions**. They are not modules; they are the lenses every module and
future feature exists to serve. **Every major module and future feature should feed at least one of
these functions.**

### Reality
*What is true right now?* — the owner's current, factual position across their life, established from
structured data and deterministic calculation, not guesswork.

### Risk
*What is getting worse, may be missed, or could hurt the owner?* — deterioration, deadlines, exposure,
and fragilities surfaced **before** they become emergencies.

### Advantage
*What opportunity, leverage, improvement, or upside exists?* — openings the owner could act on to
improve their position, including small compounding gains.

### Decision
*What are the realistic options, tradeoffs, confidence levels, constraints, and likely outcomes?* — the
honest comparison the owner needs to choose well, including what is uncertain.

### Execution
*What should happen next, when should it happen, and how will Xanther know whether it worked?* — the
concrete next action, its timing, and the way its result will be verified and recorded.

---

## 3. Product principles

- **Privacy by default.** Private information stays private; nothing is exposed or published
  automatically.
- **AI assists; the owner decides.** Xanther advises and prepares; the owner makes the call.
- **Consequential actions require explicit owner confirmation.**
- **Structured, deterministic systems establish facts, calculations, constraints, and eligibility.**
- **AI may interpret, summarize, compare, personalize, and communicate — but must not invent underlying
  facts.**
- **Deterministic fallbacks should remain available where practical**, so core value survives when AI is
  unavailable or uncertain.
- **Complete functional workflows take priority over decorative features.**
- **Xanther should remain calm, concise, personal, and useful** rather than becoming an overwhelming
  control panel.
- **Cross-domain reasoning is a core requirement**, not an optional enhancement.
- **Recommendations should account for time, money, energy, stress, schedule, obligations, relationships,
  and personal capacity.**
- **Modules serve the owner's broader goals; they are not isolated mini-products.**

---

## 4. Core recommendation lifecycle

Xanther's central operating loop. A recommendation is a **tracked object with memory**, not a disposable
card.

1. **Notice** — a structured/deterministic signal or change is detected.
2. **Explain** — Xanther states what it noticed and why it matters, with evidence.
3. **Recommend** — a bounded, realistic next action with its tradeoffs.
4. **Owner responds** — accepts, rejects, defers, or marks *not relevant*.
5. **Execute or create the next action** — carry it out (only within permitted, confirmed bounds) or
   create the concrete follow-up.
6. **Verify the result** — check whether the intended outcome actually happened.
7. **Record the outcome** — preserve what happened.
8. **Learn from the pattern** — use the outcome to improve future noticing, explaining, and recommending.

A recommendation should be able to include:

- observation;
- why it matters;
- evidence;
- personal relevance;
- expected upside;
- tradeoff;
- estimated cost;
- time required;
- confidence;
- urgency;
- next action;
- required verification;
- owner response;
- outcome;
- what Xanther learned.

**Recommendations are not disposable cards.** They persist through their lifecycle so Xanther can verify
follow-through and learn over time.

---

## 5. Daily Command Center vision

*(Vision only — not approved for implementation in this phase.)*

Opening Xanther should answer, at a glance:

- What do I need to know today?
- What changed?
- What needs action?
- What is at risk?
- What opportunity should I consider?
- What am I neglecting?
- What can wait?
- What realistic move would improve today or this week?

The **first** Daily Command Center should eventually support a small, prioritized set:

- **Today**
- **What changed**
- **One risk**
- **One opportunity**
- **One relationship action**
- **One experience or curiosity item**
- **One recommended next move**

It should remain **concise and prioritized** — a calm daily briefing, never an exhaustive dashboard.

---

## 6. Cross-domain reasoning

Xanther must eventually reason **across** domains rather than treating each as a silo:

- finance and credit;
- tasks and obligations;
- calendar and schedule;
- goals and progress;
- relationships;
- health and energy;
- career and opportunity;
- experiences and travel;
- knowledge and curiosity.

The value is in the connections between them. Examples:

- A trip may be **affordable but badly timed** because rent is due.
- A job may **fit the owner's skills but conflict** with transportation or schedule.
- A financial action may **help credit while weakening the emergency buffer**.
- A social action may **deserve priority when the owner has been isolated**.
- An event may be a **good fit only if budget, schedule, distance, and companions align**.

A recommendation that ignores an adjacent domain (money vs. timing, skills vs. logistics, credit vs.
cash buffer, opportunity vs. capacity) is incomplete.

---

## 7. Role of AI

AI should become a **central interpretation and interaction layer**, not a decorative chatbot bolted onto
personal data. The intended pattern:

- structured systems establish **reliable facts**;
- deterministic services calculate **bounded results**;
- AI **interprets and prioritizes** those results;
- AI **explains reasoning and uncertainty**;
- **consequential actions require confirmation**;
- **decisions and outcomes are preserved**;
- **no hidden autonomous behavior.**

AI's job is to make the deterministic foundation understandable, personal, and actionable — never to
manufacture the facts underneath it.

---

## 8. Hard boundaries

Xanther must **never automatically**:

- spend or move money;
- apply for credit, jobs, housing, insurance, or services;
- contact people;
- publish content;
- expose private information;
- file disputes;
- accept legal or financial terms;
- delete important records;
- make irreversible decisions;
- impersonate the owner;
- represent uncertain information as fact.

Each of these requires **explicit owner authorization** and, where appropriate, **additional
verification**. These boundaries are non-negotiable and align with `docs/PRODUCT_VISION.md`.

---

## 9. Feature approval test

> **Every new feature must either improve a decision, surface an opportunity, reduce a risk, or help
> complete an action in the owner's real life.**

If a feature only **stores more data** without improving one of those outcomes, it is **insufficient by
itself**. New verticals are justified by the decisions, opportunities, risks, and actions they enable —
not by the volume of data they capture.

---

## 10. Strategic sequence

The approved direction (order matters; each step is gated by explicit owner approval before
implementation):

1. **Finance 1C.0A is complete.**
2. **Formalize Xanther's product alignment** *(this document).*
3. **Design the Daily Command Center / Personal Advantage Loop** *(design first — not yet approved to
   build).*
4. **Connect existing Finance, Tasks, Calendar, and Goals data** into that loop.
5. **Add recommendation response and outcome memory** (owner responses, outcomes, and learning).
6. **Return to Experience and Adventure** as the first rich cross-domain, AI-assisted workflow.
7. **Expand into Relationships, Career, Knowledge, and Health** — after the orchestration layer exists.

---

## 11. Current-state interpretation

Xanther currently has a **strong finance and personal-data foundation** (tasks, obligations, finances,
bank-evidence import, categorization, spending insights, and a manual credit + financial-health baseline),
but **much of it remains capability without orchestration** — deep in individual domains, thin in the
connective daily experience that turns data into decisions.

**The next major value should come from unifying existing systems into a daily operating experience — not
from automatically building another deep vertical module.** The priority is the orchestration layer (the
recommendation lifecycle and Daily Command Center), which makes the existing foundation *usable as a
strategist*, before adding more standalone depth.
