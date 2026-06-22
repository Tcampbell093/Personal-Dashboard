# Experience and Adventure Loop — v1 Specification

> Source: final specification from the ChatGPT product-strategy review, supplied by the owner
> and stored here as the authoritative target v1 product specification. GitHub + `/docs` are
> the source of truth.

## Status & authorization

- **Status:** Awaiting final owner review. Do not begin implementation.
- **Task:** Implement the first complete workflow: Experience and Adventure Loop v1.
- **Product owner decision:** The Experience and Adventure Loop is approved as the first
  end-to-end Personal Life OS workflow.
- **Implementation authorization:** **Not yet granted.** Claude must not modify code, schema,
  dependencies, configuration, or UI until the owner approves this final specification.

> **Implementation status (updated 2026-06-22).** The original authorization line above is
> historical. The owner has since approved and gated the work in phases; current reality lives in
> `docs/CURRENT_STATE.md` and `docs/HANDOFF.md`. Implemented so far:
> - **Build 1** (manual lifecycle: request → constraints → manual plan → resolve → XP → history →
>   delete-recovery) — committed `5b17ec5`.
> - **Build 2A** (AI interpretation of the request into structured constraints, Haiku;
>   `interpreted` status + provenance) — committed `1409c37`.
> - **Build 2B.1** (AI recommendation **generation**: Stage C below, Sonnet; exactly three
>   validated concepts on `experience_requests.recommendations`; `recommendations_ready` status;
>   `recommendationSource/Provider/Model`) — implemented, awaiting review.
>
> Still **not** implemented: recommendation **selection** + one-action plan creation
> (`experiences.selected_recommendation_id`) — **Build 2B.2**, separately gated. The
> `experience_request_status = closed` value and `experience_interpretation_source = fallback`
> value defined below are **deferred** until a build implements close/archive and fallback
> behavior respectively (no static fallback catalog exists). Each build remains a separate
> approval gate; AI stays off by default.

## 1. Goal

Build the smallest useful private workflow that lets the owner:

1. describe a desired experience in natural language;
2. review and edit the system's interpretation of practical constraints;
3. receive a small number of personalized recommendation concepts with explanations;
4. select and save one recommendation as a planned experience;
5. later mark it completed, cancelled, or not completed;
6. optionally record actual cost, rating, reflection, and non-completion reason;
7. preserve the outcome in private experience history;
8. receive simple Adventure XP for completion; and
9. retain structured outcome data that may support future recommendations without implementing
   automatic preference learning in v1.

The workflow must remain fully usable when AI is disabled, unavailable, over budget, malformed,
or otherwise unsuccessful.

## 2. Final user journey

### Stage A — Start a request
The owner opens the dedicated `/experiences` page and enters a natural-language request.
Example:
> I want something memorable to do Saturday afternoon. I have about $80, I do not want to drive
> more than 45 minutes, and I want to feel energized without doing anything physically
> exhausting.

The original request text is preserved exactly as entered. The owner may also enter or edit
structured fields manually before using AI.

### Stage B — Interpret constraints
When the owner explicitly selects an action such as **Interpret my request**, the system may
call the configured AI provider through the provider-adapter boundary. The system proposes
structured values for:

- available date;
- available time or daypart;
- maximum budget;
- starting location;
- maximum travel miles;
- maximum travel minutes;
- energy level;
- desired feeling;
- maximum physical difficulty;
- interests or experience themes;
- exclusions or things to avoid.

Starting location is prefilled from `user_preferences.homeArea` when available. The prefilled
location remains editable for the individual request. Editing it must not update
`user_preferences.homeArea`. Every interpreted field remains editable. The owner must confirm
or edit the constraints before recommendation generation. AI interpretation is a proposal, not
authoritative input.

### Stage C — Generate recommendations
After constraints are confirmed, the owner explicitly requests recommendations. The system
returns between one and five recommendation candidates, targeting three. Each recommendation
contains:

- title;
- concise description;
- explanation of why it fits;
- estimated minimum cost;
- estimated maximum cost;
- estimated duration;
- location or location guidance expressed as text;
- travel-assumption text;
- physical difficulty;
- intended feeling;
- assumptions;
- optional preparation notes.

Recommendations in v1 are experience concepts. They must not claim that a specific venue,
event, ticket, business, price, opening time, route, or availability has been externally
verified. The owner may:

- select one recommendation;
- regenerate recommendations through another explicit request, subject to cost controls;
- switch to fallback recommendations;
- manually create a plan without selecting an AI recommendation.

### Stage D — Save a planned experience
The owner selects one candidate and reviews an editable plan form. The owner may edit:

- title;
- description;
- planned date;
- planned time or daypart;
- location text;
- expected cost;
- expected duration;
- physical difficulty;
- desired feeling;
- personal notes.

Saving creates one durable `experiences` record with status `planned`. The selected
recommendation is copied into the durable experience record. The request retains its validated
recommendation JSON, but unselected candidates do not become separate life-history entities.
The related request moves to a lifecycle state indicating that a plan was selected.

### Stage E — Resolve the experience
A planned experience can later be marked `completed`, `cancelled`, or `not_completed`. When
resolving it, the owner may optionally enter:

- actual cost;
- rating from 1 through 5;
- reflection;
- cancellation or non-completion reason;
- the checkbox: **This felt like a meaningful experience.**

The meaningful-experience checkbox is owner-controlled. No algorithm may set or infer it in v1.
Completion must not be blocked by a missing rating, reflection, or actual cost.

### Stage F — Award XP and preserve history
XP is determined only when the owner saves an outcome:

- `completed`: 10 XP;
- `completed` with `meaningfulExperience = true`: 15 XP total;
- `cancelled`: 0 XP;
- `not_completed`: 0 XP.

The XP value is stored on the experience record so historical awards do not silently change if
rules change later. Resolved experiences remain in private history. The page shows, at minimum:
planned experiences; resolved experience history; total Adventure XP.

History may later inform recommendations, but v1 only stores the structured data. It does not
automatically modify preferences, weights, hidden profiles, or AI prompts based on history.

## 3. Final schema design

Use two durable entities: `experience_requests`; `experiences`. Do not create a separate
`experience_recommendations` table in v1. All tables must follow the existing repository
conventions: serial primary key; server-assigned `userId`; `createdAt`; `updatedAt`;
`deletedAt`; soft deletion; ownership checks in the service layer.

### 3.1 Required enums

**`experience_request_status`** — `draft`, `interpreted`, `recommendations_ready`, `planned`,
`closed`.
- `draft` — request exists but constraints are not yet confirmed;
- `interpreted` — structured constraints entered or interpreted and ready for owner confirmation;
- `recommendations_ready` — validated candidates are stored;
- `planned` — one recommendation or manual concept was saved as an experience;
- `closed` — request was abandoned or intentionally closed without creating a plan.

The request status is workflow metadata. It does not replace the status of the selected durable
experience.

**`experience_status`** — `planned`, `completed`, `cancelled`, `not_completed`.

**`experience_interpretation_source`** — `manual`, `ai`, `fallback`.

**`experience_energy_level`** — `low`, `medium`, `high`. Nullable when unspecified.

**`experience_physical_difficulty`** — `easy`, `moderate`, `challenging`. Nullable when
unspecified.

**AI provider/model values** — Do not create a database enum tied to a particular provider or
model. Provider and model identifiers should be stored as bounded text where logging is
required, allowing the provider adapter to change without a migration.

### 3.2 `experience_requests`
Required fields: `id`, `userId`, `requestText`, `availableDate`, `availableTimeText`,
`budgetMax`, `startingLocation`, `maxTravelMiles`, `maxTravelMinutes`, `energyLevel`,
`desiredFeeling`, `maxPhysicalDifficulty`, `interests`, `exclusions`, `interpretationSource`,
`interpretationProvider`, `interpretationModel`, `recommendations`, `recommendationSource`,
`recommendationProvider`, `recommendationModel`, `status`, `createdAt`, `updatedAt`,
`deletedAt`.

Field requirements:
- `requestText`: required non-empty text.
- `availableDate`: nullable date.
- `availableTimeText`: nullable text. May contain a daypart or manually entered time range.
- `budgetMax`: nullable non-negative numeric value.
- `startingLocation`: nullable text, optionally prefilled from `user_preferences.homeArea`.
- `maxTravelMiles`: nullable non-negative integer.
- `maxTravelMinutes`: nullable non-negative integer.
- `energyLevel`: nullable `experience_energy_level`.
- `desiredFeeling`: nullable text.
- `maxPhysicalDifficulty`: nullable `experience_physical_difficulty`.
- `interests`: validated JSON string array, default empty array.
- `exclusions`: validated JSON string array, default empty array.
- `interpretationSource`: required `experience_interpretation_source`, default `manual`.
- `interpretationProvider`: nullable bounded text.
- `interpretationModel`: nullable bounded text.
- `recommendations`: validated JSON array, default empty array.
- `recommendationSource`: nullable `experience_interpretation_source`.
- `recommendationProvider`: nullable bounded text.
- `recommendationModel`: nullable bounded text.
- `status`: required `experience_request_status`, default `draft`.

The provider and model fields are provenance only. They must not contain prompts, API keys,
secrets, or raw provider responses.

### 3.3 `experiences`
Required fields: `id`, `userId`, `requestId`, `selectedRecommendationId`, `title`,
`description`, `plannedDate`, `plannedTimeText`, `locationText`, `expectedCost`, `actualCost`,
`expectedDurationMinutes`, `physicalDifficulty`, `desiredFeeling`, `notes`, `status`,
`completedAt`, `resolvedAt`, `nonCompletionReason`, `rating`, `reflection`,
`meaningfulExperience`, `adventureXp`, `createdAt`, `updatedAt`, `deletedAt`.

Field requirements:
- `requestId`: required foreign key to the owner's `experience_requests` record.
- `selectedRecommendationId`: nullable text identifier copied from recommendation JSON. Nullable
  for manually created plans.
- `title`: required bounded text.
- `description`: nullable text.
- `plannedDate`: nullable date.
- `plannedTimeText`: nullable text.
- `locationText`: nullable text.
- `expectedCost`: nullable non-negative numeric value.
- `actualCost`: nullable non-negative numeric value.
- `expectedDurationMinutes`: nullable non-negative integer.
- `physicalDifficulty`: nullable `experience_physical_difficulty`.
- `desiredFeeling`: nullable text.
- `notes`: nullable text.
- `status`: required `experience_status`, default `planned`.
- `completedAt`: nullable timestamp; set only for completed outcomes.
- `resolvedAt`: nullable timestamp; set for completed, cancelled, or not-completed outcomes.
- `nonCompletionReason`: nullable text; may be used for cancelled and not-completed outcomes.
- `rating`: nullable integer from 1 through 5.
- `reflection`: nullable text.
- `meaningfulExperience`: required boolean, default false.
- `adventureXp`: required non-negative integer, default 0.

Rules:
- `meaningfulExperience` only affects XP when status is `completed`.
- Cancelled or not-completed experiences must store 0 XP.
- Marking a completed experience meaningful awards 15 total XP, not 10 plus 15.
- A manually created plan may have no selected recommendation identifier.
- Updating the request-specific location must not update the permanent home-area preference.
- No photo field is included.

## 4. Recommendation JSON structure

`experience_requests.recommendations` stores a validated array of recommendation objects.

```ts
type ExperienceRecommendation = {
  id: string;
  title: string;
  description: string;
  whyItFits: string;
  estimatedCostMin: number | null;
  estimatedCostMax: number | null;
  estimatedDurationMinutes: number | null;
  locationText: string | null;
  travelAssumption: string | null;
  physicalDifficulty: "easy" | "moderate" | "challenging" | null;
  intendedFeeling: string | null;
  assumptions: string[];
  preparationNotes: string[];
};
```

Validation requirements:
- The top-level value must be an array.
- Valid arrays contain between 1 and 5 recommendations.
- The target generated count is 3.
- Every recommendation must have a unique non-empty `id` within the request.
- `title`, `description`, and `whyItFits` are required non-empty strings.
- Cost values must be null or non-negative finite numbers.
- When both cost values exist, `estimatedCostMax` must be greater than or equal to
  `estimatedCostMin`.
- Duration must be null or a positive integer.
- Difficulty must be null or one of the approved enum values.
- `assumptions` and `preparationNotes` must be arrays of strings.
- Unknown fields from AI output must not automatically become trusted stored fields.
- Provider output must be parsed into the application-owned contract before persistence.
- Raw unvalidated AI responses must not be stored in the recommendations column.
- Invalid recommendation output must be rejected as a complete batch. Do not persist a partially
  valid recommendation set.
- Text lengths must have reasonable application-level limits to prevent oversized provider
  output.
- Recommendation IDs are application-generated or validated opaque identifiers. They are not
  database IDs.

Recommendation truthfulness rules: recommendations must describe conceptual possibilities. They
must not state or imply that the application has confirmed current opening hours; current ticket
availability; a live event date; exact driving distance; calculated travel time; current
weather; a current price; a reservation; safety conditions; accessibility conditions. Any
estimate or assumption must be labeled as such.

## 5. API responsibilities

Follow the existing App Router route-handler pattern. Exact route naming may be proposed in the
implementation plan, but responsibilities must remain bounded as follows.

**Experience-request APIs** must support: creating a draft request; reading the owner's
requests; reading one request owned by the owner; updating editable constraints; invoking
owner-triggered AI interpretation; confirming manually edited constraints; invoking
owner-triggered recommendation generation; invoking fallback recommendation generation;
replacing recommendations only after full validation; closing or soft-deleting a request;
creating one planned experience from a selected recommendation or manual plan.

**Experience APIs** must support: listing planned experiences; listing resolved history; reading
one owner-owned experience; editing a planned experience; resolving an experience as completed,
cancelled, or not completed; calculating and storing XP server-side; soft deletion if deletion
is exposed; returning an Adventure XP summary.

**API rules:**
- Resolve `userId` server-side.
- Ignore or reject client-provided authoritative ownership fields.
- Validate all request bodies.
- Validate allowed status transitions.
- Enforce owner scope in every read and mutation.
- Return `404` or the repository's established safe equivalent when a record is not owned by the
  current owner.
- Do not persist AI recommendations until the complete batch passes validation.
- Do not call an AI provider from ordinary GET requests, page loads, dashboard loads, scheduled
  functions, or background processes.
- Avoid duplicate plan creation when the same recommendation-selection request is retried.
- Return clear machine-readable errors for: validation failure; AI disabled; monthly ceiling
  reached; per-request protection reached; provider unavailable; malformed provider response;
  database failure.

## 6. Service responsibilities

Use dedicated service modules following existing repository conventions.

**Experience-request service** — list/get/create/update/soft-delete operations; ownership-scoped
queries; home-area prefill lookup; constraint validation; request lifecycle transitions;
validated recommendation persistence; provenance fields; copying a selected recommendation into
a new `experiences` row; ensuring one selection action does not create duplicate plans.

**Experience service** — list planned experiences; list resolved history; get/update/soft-delete;
status-transition validation; outcome validation; server-side XP calculation; Adventure XP total
calculation; mapping rows to experience view models.

**AI orchestration service** — accepting only owner-triggered interpretation or recommendation
commands; checking AI availability and cost controls before each call; using the configured
provider adapter; supplying minimal relevant context; validating provider output; recording
provider/model provenance; recording usage and estimated cost; returning typed application-owned
results; failing without damaging the manual workflow. The domain services must not directly
import a provider-specific SDK.

**Rule-based fallback service** — interpreting nothing automatically unless deterministic parsing
is safe; allowing manual constraint completion; returning a small recommendation set from local
application-owned templates; filtering or ranking templates using confirmed fields such as
budget, energy, desired feeling, and difficulty; clearly labeling fallback recommendations as
general concepts; functioning without network or AI access.

## 7. Page and component boundaries

Build the workflow on `/experiences`. Do not place the complete workflow on the existing
dashboard. A future dashboard link or small summary is outside this task unless a minimal
navigation link is required to make `/experiences` discoverable.

Suggested page sections: (1) New experience request; (2) Confirmed constraints;
(3) Recommendations; (4) Planned experiences; (5) Experience history; (6) Adventure XP summary.
These may be separate components, but the implementation must prioritize a clear workflow over
visual complexity.

Component responsibilities:
- **Request capture** — natural-language request input; save/create draft; manual continuation;
  explicit AI interpretation action.
- **Constraint editor** — editable structured fields; home-area prefill; validation;
  confirmation; explicit recommendation-generation action; fallback action.
- **Recommendation-list** — displays 1–5 validated candidates; displays explanations and
  assumptions; allows one candidate to be selected; allows owner editing before plan creation;
  supports manual-plan creation.
- **Planned-experience** — lists planned records; permits bounded editing; opens outcome
  resolution.
- **Outcome form** — completed/cancelled/not-completed selection; optional actual cost; optional
  rating; optional reflection; optional non-completion reason; meaningful-experience checkbox;
  preview or explanation of XP result.
- **History** — resolved records in reverse chronological order; status; actual cost when
  present; rating when present; reflection when present; XP; no photo UI.
- **XP summary** — displays total stored Adventure XP; no levels, streaks, badges, progress bars
  requiring a progression system, or spendable currency.

UI architecture (follow existing conventions): server-rendered page data; client islands for
forms and mutations; API mutation followed by `router.refresh()`; application view models rather
than raw Drizzle row types; no independent client-side source-of-truth store.

## 8. AI provider-adapter boundary

Implement an application-owned provider interface that prevents domain code from depending
directly on one provider or model.

```ts
interface ExperienceAiProvider {
  interpretExperienceRequest(
    input: ExperienceInterpretationInput
  ): Promise<ExperienceInterpretationResult>;

  generateExperienceRecommendations(
    input: ExperienceRecommendationInput
  ): Promise<ExperienceRecommendationResult>;
}
```

The exact names may change, but the separation must remain.

Provider-neutral application contracts. The domain layer owns: interpretation input shape;
interpretation output shape; recommendation input shape; recommendation JSON shape; validation;
error categories; usage metadata shape. A provider adapter owns: converting application input
into provider-specific messages; making the provider call; converting provider output into the
application contract; returning provider/model/token/cost metadata where available.

Provider selection — the initial provider and model are not approved by this task. Before
implementation begins, Claude must separately propose: the provider; the model; expected cost
per interpretation; expected cost per recommendation request; structured-output support; SDK or
HTTP dependency impact; fallback behavior; environment-variable names; privacy considerations.
The owner must approve that proposal before provider-specific implementation or dependency
installation.

No background AI — AI calls may occur only after an explicit owner action. Do not call AI from:
page load; dashboard load; scheduled functions; background jobs; automatic retries outside the
active owner request; request creation alone; experience completion; history loading.

## 9. Manual and rule-based fallback behavior

The complete workflow must remain usable with no AI provider configured.

Manual interpretation fallback — the owner can: enter the natural-language request; manually
complete or edit every structured field; confirm the constraints without AI.

Rule-based recommendation fallback — use a small local, application-owned concept catalog.
Suggested categories may include: nature; culture; food; creative; entertainment; learning;
relaxation; physical activity; local exploration; social; solo outing. Each fallback concept
should define structured attributes such as: indicative budget band; energy suitability;
difficulty; intended feelings; typical duration; assumptions. The rule-based service may filter
and rank concepts against confirmed constraints. It must not pretend to have current external
information.

Manual-plan fallback — the owner can bypass generated recommendations and create a planned
experience manually from confirmed constraints. The fallback path must still support: saving a
plan; resolving its outcome; history; XP.

## 10. Cost-limit behavior

Monthly development ceiling — the hard development AI ceiling is **$5 per calendar month**. This
ceiling applies to owner-triggered AI use for this workflow during the development stage. The
application should use the existing intelligence-settings and API-usage-log architecture where
appropriate rather than creating a disconnected cost-control mechanism.

Per-request protection — the final provider proposal must define a hard per-call or
per-owner-action protection before implementation. The protection must include, at minimum:
maximum input size; maximum output size or token allowance; maximum estimated cost for one
interpretation call; maximum estimated cost for one recommendation-generation call; no unbounded
automatic retries. The exact dollar or token thresholds require the provider/model proposal
because they depend on pricing and structured-output behavior.

Required behavior — before an AI call: (1) confirm AI is configured; (2) confirm the kill switch
permits the call; (3) calculate current recorded monthly spend; (4) estimate or bound the
pending request cost; (5) reject the AI call if it could exceed the monthly ceiling or
per-request protection. After a successful or failed provider call: record provider; operation;
token counts when available; estimated cost; success/failure; bounded error information.

Ceiling reached — when the monthly ceiling is reached or the pending request would exceed it:
do not call the provider; return an explicit AI-budget-disabled result; explain that manual
entry and fallback recommendations remain available; do not disable saving, planning,
completion, history, or XP; do not automatically increase the ceiling; do not silently use
another paid provider.

Provider failure — provider failure must not trigger repeated paid retries automatically. At
most, the owner may choose to retry through another explicit action after seeing the failure.

## 11. Privacy and ownership requirements

- Every request and experience is private by default.
- No experience data may be published automatically.
- No part of this task may create or update the public-identity surface.
- `userId` is resolved on the server.
- Clients must not choose or override record ownership.
- All reads and mutations must be owner-scoped.
- Starting-location prefill may read `user_preferences.homeArea`.
- Request-specific location edits must not update permanent preferences.
- AI receives only the information required for the current explicit operation.
- Do not send unrelated finances, obligations, jobs, signals, reflections, or complete personal
  history to the provider.
- Do not send authentication secrets or internal identifiers unnecessarily.
- Do not store API keys, provider credentials, or environment-variable values in the database,
  logs, docs, client bundle, or API responses.
- Reflections and non-completion reasons are sensitive private data.
- Do not include full request text, reflections, or raw AI prompts in general application logs.
- API usage logs should contain bounded operational metadata, not full personal content.
- Raw unvalidated provider output should not become durable personal memory.
- No automatic preference learning or hidden behavioral profile is allowed in v1.
- Experience history may be used by future work only after a separate approved task defines what
  data is used and how.

## 12. Failure behavior

Database unavailable — do not silently fabricate mock personal requests, recommendations, plans,
outcomes, or XP. The Experience workflow should show an explicit unavailable/error state.
Existing dashboard mock fallback should not be extended to create fictional personal-history
records.

Interpretation failure — preserve the original request; preserve manually entered fields; show a
clear error; allow manual constraint entry; allow a new explicit retry; do not change the
request to a misleading interpreted state.

Recommendation failure — preserve the request and confirmed constraints; do not persist a
partial or invalid batch; show a clear error; allow fallback recommendations; allow manual plan
creation; allow explicit retry when cost limits permit.

Invalid AI output — reject the complete batch; return a structured validation error; record a
bounded failed-usage log; do not expose raw provider output as trusted UI content; do not
persist malformed recommendation JSON.

AI disabled or unconfigured — explain that AI is unavailable; keep manual interpretation active;
keep fallback recommendations active; keep plan, outcome, history, and XP functionality active.

Cost ceiling reached — do not call AI; display the ceiling condition; preserve all entered data;
keep the manual and fallback workflow active.

Save failure — retain the owner's current client-side form state where practical; show a clear
failure; avoid duplicate records on retry; do not advance lifecycle status unless the durable
write succeeds.

Duplicate plan submission — the system must prevent or safely handle repeated submissions for
the same selected recommendation. A retry must not silently create multiple planned experiences.

Invalid outcome — reject: unsupported statuses; negative actual cost; ratings outside 1–5; XP
supplied authoritatively by the client; meaningful-experience XP on non-completed statuses. XP
must be calculated by the server.

Outcome without optional details — allow completion, cancellation, or not-completion even when
optional fields are empty.

Request-specific location change — a changed request location must remain local to the request
and selected experience. It must not mutate `user_preferences.homeArea`.

## 13. Acceptance criteria

**Request capture**
1. `/experiences` is accessible to the authenticated owner.
2. The owner can create a request using natural-language text.
3. The original request text persists.
4. Home area is prefilled when available.
5. The owner can change the request location without changing the permanent preference.
6. The owner can complete all structured fields manually.
7. Negative budget, miles, or minutes are rejected.

**AI interpretation**
1. AI interpretation occurs only after an explicit owner action.
2. Domain code uses a provider-neutral adapter.
3. The owner can review and edit every interpreted value.
4. AI interpretation provenance may be stored without storing secrets or raw responses.
5. Interpretation failure leaves the request usable manually.
6. No AI call occurs when AI is unavailable, killed, over budget, or over per-request limits.

**Recommendations**
1. Recommendation generation occurs only after an explicit owner action.
2. A valid result contains 1–5 recommendations, targeting 3.
3. Every stored recommendation matches the validated JSON contract.
4. Every recommendation has a unique ID within the request.
5. Every recommendation explains why it fits.
6. Assumptions are visible.
7. Recommendations do not claim verified external availability.
8. Invalid AI output is not partially persisted.
9. Fallback recommendations work without AI.
10. The owner can manually create a plan without generated recommendations.

**Planning**
1. The owner can select one recommendation.
2. The selected candidate can be edited before saving.
3. Saving creates one `experiences` record with status `planned`.
4. The planned experience survives refresh and restart.
5. A duplicate submission does not create duplicate plans.
6. Unselected candidates do not become separate durable experience records.
7. The request moves to the appropriate planned lifecycle state only after the experience is
   saved.

**Outcome**
1. A planned experience can become `completed`.
2. A planned experience can become `cancelled`.
3. A planned experience can become `not_completed`.
4. Actual cost is optional and rejects negative values.
5. Rating is optional and accepts only integers 1–5.
6. Reflection is optional.
7. Non-completion reason is optional.
8. The meaningful-experience checkbox is owner-controlled.
9. Completion is not blocked by missing rating, reflection, or cost.
10. Server-side XP rules are: completed: 10; completed and meaningful: 15 total; cancelled: 0;
    not completed: 0.
11. Client-supplied XP cannot override the server calculation.
12. Resolved records remain in history.

**History and XP**
1. Planned and resolved experiences are displayed separately.
2. Resolved history is private and persistent.
3. History displays the final status.
4. History displays actual cost, rating, reflection, and reason when present.
5. History displays awarded XP.
6. Total Adventure XP equals the sum of stored awarded XP for live owner-owned experience
   records.
7. No levels, badges, streaks, achievements, or spendable XP are created.

**Ownership and privacy**
1. All records use server-resolved ownership.
2. Owner scope is enforced for every read and mutation.
3. The client cannot assign records to another user.
4. No workflow data is published.
5. No request-specific location edit updates permanent user preferences.
6. Sensitive content is not written into general logs.
7. AI receives only request-relevant data.

**Cost and fallback**
1. Recorded monthly AI cost cannot intentionally exceed the $5 development ceiling.
2. Pending calls that could exceed the ceiling are blocked before provider invocation.
3. Per-request protection blocks oversized or over-cost calls.
4. Reaching the AI ceiling does not disable manual interpretation.
5. Reaching the AI ceiling does not disable fallback recommendations.
6. Reaching the AI ceiling does not disable planning, outcomes, history, or XP.
7. No background or scheduled AI calls occur.

**Engineering verification**
1. Relevant schema migration is generated and committed.
2. `npm run typecheck` passes.
3. `npm run build` passes.
4. Applicable lint command is run and honestly reported.
5. API lifecycle is manually exercised.
6. Browser lifecycle is manually exercised.
7. AI-disabled fallback is manually exercised.
8. AI-failure behavior is manually exercised.
9. Cost-ceiling behavior is manually exercised.
10. Documentation is updated to reflect the verified current state.

## 14. Manual browser test scenarios

**Scenario 1 — AI-assisted request:** open `/experiences`; enter a natural-language request with
date, budget, travel, energy, feeling, and difficulty clues; trigger interpretation; confirm
proposed fields appear; edit at least one interpreted field; confirm constraints; generate
recommendations; confirm 1–5 candidates appear; confirm each includes `whyItFits` and
assumptions; select one; edit its plan details; save it; refresh; confirm it remains under
planned experiences.

**Scenario 2 — Home-area prefill isolation:** ensure `user_preferences.homeArea` has a value;
start a new request; confirm the starting location is prefilled; change the request location;
save or continue; confirm the request uses the changed location; confirm the permanent home-area
preference remains unchanged.

**Scenario 3 — AI unavailable:** disable or omit AI provider configuration; create a request;
attempt interpretation; confirm a clear unavailable state appears; complete constraints manually;
generate fallback recommendations; save a plan; resolve it; confirm the complete workflow remains
usable.

**Scenario 4 — AI cost ceiling:** set recorded development usage at or near the $5 ceiling using
safe test data; attempt an owner-triggered AI operation; confirm the provider is not called;
confirm the page explains that the AI budget is unavailable; confirm manual entry and fallback
recommendations remain usable; confirm existing plans and history remain usable.

**Scenario 5 — Completed experience:** open a planned experience; mark it completed; leave rating
and reflection empty; save; confirm completion succeeds; confirm 10 XP is stored and displayed.

**Scenario 6 — Meaningful completion:** complete another planned experience; check meaningful;
save; confirm 15 total XP; confirm it is not calculated as 25 XP.

**Scenario 7 — Cancelled:** mark a planned experience cancelled; optionally enter a reason; save;
confirm 0 XP; confirm it remains in history.

**Scenario 8 — Not completed:** mark a planned experience not completed; leave the reason empty;
save; confirm the outcome is accepted; confirm 0 XP; confirm it remains in history.

**Scenario 9 — Invalid fields:** verify visible validation for negative budget; negative travel
miles; negative travel minutes; negative actual cost; rating 0; rating 6; invalid or missing
required title during plan creation.

**Scenario 10 — Duplicate selection submission:** select a recommendation; submit the plan action
twice through rapid retry or refresh behavior; confirm only one planned experience is created.

**Scenario 11 — Database failure:** make the experience database path unavailable in a safe dev
environment; load `/experiences`; confirm the workflow shows an explicit error; confirm it does
not show fabricated mock plans, history, or XP.

## 15. Manual API test scenarios

**Request lifecycle:** create a valid draft request; create a request with empty `requestText`
(expect validation failure); update owner-owned constraints; submit negative numeric constraints
(expect validation failure); read one owner-owned request; attempt to read an invalid or
non-owned ID (expect safe not-found behavior); close or soft-delete a request; confirm
soft-deleted requests do not appear in normal lists.

**Interpretation endpoint:** submit a valid explicit interpretation request; confirm
application-contract output; confirm provenance metadata is bounded; disable AI and retry (expect
explicit unavailable response); trigger monthly-ceiling behavior (confirm no provider call);
trigger per-request size protection; simulate provider failure; simulate malformed structured
output; confirm the durable request remains intact after every failure.

**Recommendation endpoint:** generate a valid 3-item batch; return one valid item (confirm it is
accepted); return more than five (expect rejection); return duplicate recommendation IDs (expect
rejection); return negative cost (expect rejection); return max cost lower than min cost (expect
rejection); return unsupported difficulty (expect rejection); return malformed arrays (expect
rejection); confirm no partial batch is written; generate fallback recommendations without AI.

**Plan creation:** create a plan from a valid stored recommendation ID; attempt to create from an
unknown recommendation ID (expect validation failure); create a manual plan without a selected
recommendation ID; retry the same selection (confirm idempotent or duplicate-safe behavior);
confirm request and experience ownership are enforced together.

**Experience lifecycle:** update a planned experience; resolve as completed with no optional
fields; resolve as completed with rating, cost, and reflection; resolve as completed and
meaningful (verify 15 XP); resolve as cancelled (verify 0 XP); resolve as not completed (verify 0
XP); submit client XP (confirm it is ignored or rejected); submit invalid rating (expect
validation failure); submit negative actual cost (expect validation failure); confirm resolved
history listing; confirm Adventure XP total.

**Ownership:** confirm client-provided `userId` is ignored or rejected; attempt owner-mismatched
reads and mutations using controlled test fixtures; confirm records are not exposed across
ownership boundaries.

## 16. Exact in-scope file categories

Claude must propose the exact file list before implementation, but the approved categories are:

**Documentation** — `docs/HANDOFF.md`; `docs/CURRENT_STATE.md`; `docs/DATA_MODEL.md`;
`docs/DECISIONS.md` only if a new implementation decision must be recorded; possibly `README.md`
only if navigation or status documentation becomes inaccurate.

**Database** — `db/schema.ts`; one generated migration under `db/migrations/`; `db/seed.ts` only
if minimal clearly labeled development data is genuinely required.

**Domain and view models** — `lib/types.ts`; dedicated experience request service module;
dedicated experience service module; dedicated AI orchestration module; provider-neutral AI
contracts/types; provider-adapter interface; rule-based fallback module; validation helpers local
to this workflow; existing auth and database helpers may be imported but should not be broadly
refactored.

**AI cost controls** — existing intelligence-settings service or a narrowly scoped extension;
existing API-usage logging service or a narrowly scoped extension; provider-specific adapter only
after a provider/model proposal receives separate approval; environment example only after
approved provider selection; package dependencies only after approved provider selection.

**API routes** — experience-request collection/item routes; owner-triggered interpretation route;
owner-triggered recommendation route; fallback recommendation route if separate; plan-creation
route or bounded action; experience collection/item routes; outcome-resolution route if separate;
XP-summary route only if not naturally included in a collection response.

**Page and components** — dedicated `/experiences` page; request-capture component;
constraint-editor component; recommendation-list/selection component; planned-experience
component; outcome form; history component; XP summary; minimal navigation link from the existing
application only if required for discoverability; narrowly scoped CSS additions.

**Configuration and dependencies** — provider-specific configuration, SDK dependencies, or model
constants are not yet in scope. They become in scope only after the separate provider/model
proposal is approved.

## 17. Explicit non-goals

Do not include: web search; live event discovery; venue or business lookup; maps; geocoding;
coordinate storage; route planning; travel-time calculation; conversion between miles and
minutes; weather; calendar synchronization; reminders; notifications; voice input; photo fields;
photo upload; photo storage; photo analysis; ticket purchasing; reservations; booking; contacting
venues or people; automatic financial deductions; automatic creation of calendar events or
obligations; background AI; scheduled AI; automatic retries that may incur cost; automatic
preference updates; hidden recommendation weights; embeddings; vector search; recommendation-level
feedback tables; a normalized recommendations table; permanent storage of unselected candidates
as life-history entities; public sharing; public-identity integration; family or multi-user
behavior; social planning; group voting; levels; badges; streaks; achievements; skill trees; XP
spending; rewards marketplace; full dashboard redesign; broad refactoring of the seven existing
verticals; replacement of the existing authentication system; unrelated dependency upgrades; a
generalized AI platform beyond the minimum provider-adapter boundary required here.

## 18. Pre-implementation requirement

Before Claude may implement this task, it must submit a separate provider/model proposal
containing: proposed provider; proposed model; rationale; structured-output method; estimated
cost per interpretation; estimated cost per recommendation generation; recommended per-request
input limit; recommended per-request output/token limit; recommended maximum estimated cost per
operation; dependency changes; environment-variable names; privacy and retention considerations;
error behavior; how usage will be measured and written to existing logs; how the $5 monthly
ceiling will be enforced before calls.

The owner must approve that provider/model proposal and must explicitly change this task's status
to approved for implementation.

**Until then: do not implement.**
