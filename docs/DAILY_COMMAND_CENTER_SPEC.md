# Daily Command Center / Personal Advantage Loop — Specification (v1)

> **Documentation-only design.** This specification defines the *smallest complete operating loop* that
> makes Xanther useful every day. It authorizes **no** implementation: no application code, schema,
> migration, route, dependency, AI call, or UI change is created by this document. Implementation requires
> a separate, explicitly approved bounded task in `docs/HANDOFF.md`.
>
> **Grounded in:** `docs/PRODUCT_ALIGNMENT.md` (mission, the five permanent functions, the recommendation
> lifecycle, the feature-approval test), `docs/PRODUCT_VISION.md` (durable principles + hard boundaries),
> `docs/CURRENT_STATE.md` (what verifiably exists), `docs/DATA_MODEL.md` (tables), `docs/HANDOFF.md`, and
> the **actual** Finance, Tasks, Calendar-equivalent, Goals, and Home implementations in the repository
> (`lib/briefing.ts`, `lib/services/*`, `app/finances`, `components/home/*`).

---

## 0. Grounding — what actually exists today (do not fabricate the rest)

Verified from the repository at the time of writing. The first version may use **only** these as real data
sources; everything else is a truthful empty state or a future slot.

| Domain | Real source(s) in repo | Notes / limits |
|---|---|---|
| Tasks | `lib/services/tasks.ts` → `listTasks`/`toTaskViews`; `TaskView` has `priority`, `dueDate`, `status`, `completedAt` | Deterministic tiers already exist in `lib/briefing.ts`. |
| Obligations | `lib/services/obligations.ts` → `listObligations`/`toObligationViews`; `ObligationView.startDate`, `status`, `location`/`type` | Dated items; closed set = done/cancelled/missed. |
| Bills / deadlines | `lib/services/finances.ts` → `listBills`/`toBillViews`; `BillView.dueDate`, `status`, `expectedAmount` | "Paid" excluded from due. |
| Finance / cash-flow | `computeFinancialOutlook` (`nextPaydayDate`, `estimatedRemaining`, `billsDueBeforePayday`, `overdueCount`, `due7/14/30`), `computeProjection`, `computeCashSummary` | The basis for capacity checks. |
| Credit / financial-health | `lib/services/credit.ts` → `computeCreditOverview` (observations, action cards), `homeCreditSummary` (≤1 action + ≤1 progress + stale reminder) | Manual, read-only; already produces bounded signals. |
| Spending opportunities | `lib/services/insights.ts` → `computeInsights` (insights + opportunities), `homeInsightSummary` (≤1 insight + ≤1 opportunity) | Deterministic, period-scoped. |
| Categorization backlog | `lib/services/categories.ts` → `countUncategorized`; matching → `countPendingMatches` | Data-quality signals. |
| Experiences (progression) | `lib/services/experiences.ts` → `listPlanned`/`listHistory`/`xpSummary`; `plannedDate` | Progression + planned dates; **not** a general goal system. |
| Home assembly | `lib/services/home.ts` → `buildHomeView` (sections: `needsAttention`, `comingUp`, `money`, `momentum`); ranker `lib/briefing.ts` (`rankNeedsAttention`, `datedReason`, `topTask`, tiers) | The Daily Command Center **reuses** this ranker + these providers. |
| Ownership | `lib/auth.ts` → single owner `CURRENT_USER_ID = 1`; server-derived | No multi-user. |

**Not grounded (do NOT assume they exist):**
- **Calendar** — there is **no** calendar integration. `financial_connections.externalCalendarId` is a
  *reserved, unused* column ("future Google Calendar sync"). The first-version "schedule" is **derived**
  from obligation `startDate`, bill `dueDate`, income `payDate`, and experience `plannedDate` only.
- **Goals** — there is **no** general goals domain. The only implemented goals are **`credit_goals`**
  (credit-specific). Experience XP is progression, not goals. Treat "Goals" as **credit goals only** in
  v1; a general goal domain is future work.
- **Relationships, health/energy, career/jobs discovery, travel, knowledge/curiosity** — no grounded
  daily data. These are **future slots** or **truthful empty states**, never fabricated.

---

## 1. Product outcome

**When the owner opens Xanther, they receive a calm, concise, prioritized daily brief** that helps them
understand what matters, notice one meaningful risk and one opportunity, choose a realistic next move,
respond to it, and later record whether it worked.

The first version must prove this loop end-to-end:

1. **Collect** grounded facts from existing systems (§0).
2. **Normalize** them into a common signal shape (§4).
3. **Prioritize** them deterministically (§5).
4. **Produce** a bounded daily brief (§3).
5. **Present** one recommended next move (§6).
6. **Let the owner** accept, defer, reject, mark not relevant, or complete it (§7).
7. **Preserve** the response and outcome (§8).
8. **Revisit** the result later (§7 recurrence + §9 change detection).

This is the concrete instance of the Product Alignment recommendation lifecycle (Notice → Explain →
Recommend → Owner responds → Execute/next action → Verify → Record → Learn). Success = the owner can
complete this loop daily using only real data, with no consequential automation and no AI dependency.

---

## 2. First-version scope

**In scope (grounded domains only):** tasks & obligations; bills & deadlines; finance & cash-flow signals;
credit & financial-health signals; existing spending opportunities; and **credit goals** (the only
verifiably implemented "goals").

**Schedule** is the **derived** union of dated items above (no calendar integration). **Experiences** may
contribute the single "planned experience" already surfaced by `comingUp`, as a future-leaning slot.

**Out of scope for v1 (truthful empty state / future slot, never fabricated):** relationships, health &
energy, career/job discovery, travel/adventure discovery, knowledge/curiosity. A section for an
unsupported domain renders a truthful empty state ("No relationship data yet") or is simply absent — it
must never invent data.

---

## 3. Daily brief shape

**Required first-version sections** (in order). The brief is a calm briefing, never an exhaustive
dashboard.

1. **Today**
2. **What changed**
3. **One risk**
4. **One opportunity**
5. **One recommended next move**

**Future slots (not in v1 unless grounded data exists):** "One relationship action" and "One experience or
curiosity item." The experience slot *may* reuse the existing planned-experience item as a soft future
slot; the relationship slot stays absent until relationship data exists.

For each section:

### Today
- **Purpose:** orient the owner to their current position and what is due now.
- **Source data:** date, greeting/owner name (`getOwnerFirstName`); counts of open tasks/obligations due
  today or overdue; bills due today; `nextPaydayDate`; a one-line cash posture (`estimatedRemaining`).
- **Inclusion rules:** only items effective/due **today or overdue** as of the local date; only active,
  owner-scoped records.
- **Exclusion rules:** completed/paid/closed items; future-dated non-urgent items (they live in the source
  modules); anything with no grounded date.
- **Max items:** a compact header + up to **3** "due now/overdue" lines.
- **Empty state:** "You're clear for today — nothing is due or overdue."
- **Ordering:** overdue (most overdue first) → due today → soonest.
- **Evidence shown:** the item title + its date/reason (reusing `datedReason`).
- **Freshness:** recomputed on each load; date-only comparison in `America/New_York` (§13).

### What changed
- **Purpose:** surface grounded changes since the last brief so the owner isn't re-shown static facts.
- **Source data:** §9 change detection over tasks, obligations, bills, imported financial activity,
  spending, credit score/utilization, and newly stale/resolved items.
- **Inclusion rules:** only items that **materially changed** within the comparison window (§9) and were
  not already shown-and-unchanged.
- **Exclusion rules:** unchanged facts; changes below a materiality threshold (§9); changes the owner
  already acknowledged.
- **Max items:** up to **3**.
- **Empty state:** "Nothing notable changed since yesterday."
- **Ordering:** by change recency then materiality.
- **Evidence shown:** what changed, from → to where applicable, and the observed date.
- **Freshness:** depends on last-brief timestamp (§9); if no prior brief exists, v1 shows a bounded
  "recently new/overdue" set rather than a full history dump.

### One risk
- **Purpose:** the single most consequential thing getting worse, at risk of being missed, or able to hurt
  the owner (the **Risk** permanent function).
- **Source data:** normalized signals (§4) of risk type — overdue/soon-due tasks/obligations/bills,
  projected shortfall (`computeProjection` warnings), overdue credit payment, unverified collection,
  recent hard inquiries, high utilization, expected-income-unconfirmed.
- **Inclusion rules:** **at most one.** A risk is shown only when a qualifying, grounded, non-stale
  candidate (§4) passes the documented ranking threshold (§5), the capacity rules (§10), and the safety
  boundaries (§14) — the top-ranked such signal, subject to suppression (§5). If no candidate clears those
  bars, the section shows its truthful empty state. **Xanther must never manufacture or promote a weak
  risk merely to fill the slot.**
- **Exclusion rules:** items already being handled (accepted/deferred/completed recommendation covering the
  same source); low-confidence inferences presented as fact; any candidate below the ranking threshold.
- **Max items:** **at most 1** (0 when nothing qualifies).
- **Empty state:** "No pressing risks detected from your current data." (Shown whenever no candidate clears
  the threshold/capacity/safety bars.)
- **Ordering:** single item; selection rationale recorded (§5 "why chosen").
- **Evidence shown:** observation + evidence + source reference + confidence.
- **Freshness:** signal must be within its non-stale window (§4 `staleDate`).

### One opportunity
- **Purpose:** the single best opportunity/leverage/upside (the **Advantage** function).
- **Source data:** normalized signals of opportunity type — spending-reduction opportunities
  (`computeInsights`), credit action cards (`computeCreditOverview` non-risk), utilization-reduction, goal
  progress within reach.
- **Inclusion rules:** **at most one.** An opportunity is shown only when a qualifying, grounded, non-stale
  candidate passes the documented ranking threshold (§5), the capacity rules (§10), and the safety
  boundaries (§14) — the top-ranked such signal; low-confidence opportunities are hidden by default
  (consistent with existing insights behavior). If none qualifies, the section shows its truthful empty
  state. **Xanther must never manufacture or promote a weak opportunity merely to fill the slot.**
- **Exclusion rules:** opportunities already handled/deferred; anything requiring an out-of-bounds action;
  any candidate below the ranking threshold.
- **Max items:** **at most 1** (0 when nothing qualifies).
- **Empty state:** "No clear opportunity to act on right now." (Shown whenever no candidate clears the
  threshold/capacity/safety bars.)
- **Evidence shown:** observation + estimated upside + tradeoff + confidence.
- **Freshness:** within its non-stale window.

### One recommended next move
- **Purpose:** the single realistic action the owner should take next (the **Execution** function). This is
  the loop's payload and the only section that becomes a **persisted recommendation** (§6, §8).
- **Source data:** the top-ranked **actionable** signal across risk + opportunity (a recommendation may be
  the same underlying signal as the risk or opportunity, promoted to an action).
- **Inclusion rules:** **at most one — and never more than one.** A recommended move is shown only when a
  qualifying, grounded, non-stale candidate passes the documented ranking threshold (§5), the capacity
  check (§10), and the hard boundaries (§14); it must be bounded and realistic. If no candidate clears
  those bars, the section shows its truthful empty state. **Xanther must never manufacture or promote a
  weak recommendation merely to fill the slot** — an empty "no move today" is the correct, honest output
  when nothing qualifies.
- **Exclusion rules:** any move that would spend/move money, contact a person, publish, apply, or make an
  irreversible decision; any move already accepted/active; any candidate below the ranking threshold.
- **Max items:** **at most 1, and never more than 1** (0 when nothing qualifies).
- **Empty state:** "No recommended move today — you're on top of things." (Shown whenever no candidate
  clears the threshold/capacity/safety bars.)
- **Evidence shown:** the full recommended-move shape (§6).
- **Freshness:** the recommendation carries an expiration (§6); a stale unaccepted recommendation is
  regenerated rather than shown expired.

**Global concision rule:** the entire brief is capped at roughly **one screen above the fold on desktop**
and a short scroll on mobile; total actionable items across sections ≤ ~8; **never more than one recommended
move**, and risk/opportunity/move each show **at most one** item — shown only when a qualifying candidate
clears the ranking/capacity/safety bars, otherwise the truthful empty state. A weak item is never promoted
to fill a slot.

---

> **Slice 1 status (reviewed and merged to `main`, commit `0e64a64`):** the contract (§4) and the
> read-only grounded providers (slice 1 of §17) are implemented in `lib/daily/contract.ts` and
> `lib/daily/providers.ts`, verified by `scripts/verify-daily-slice1.ts` (81/81).
>
> **Slice 2 status (reviewed and merged to `main`, commit `71ff495`):** the
> failure-isolated **orchestrator** (§2) and the deterministic **ranking + bounded selection** (§5/§6/§8/§9)
> are implemented in `lib/daily/orchestrator.ts` and `lib/daily/ranking.ts`, verified by
> `scripts/verify-daily-slice2.ts` (73/73). `collectDailySignals` calls every Slice 1 provider via
> `Promise.allSettled`, validates each signal, and returns valid signals + degraded providers + invalid
> diagnostics; a **request-scoped memoized credit overview** (`SignalContext.sharedCredit`) computes
> `computeCreditOverview` once per (userId, today) run (no global/cross-user cache, no persistence;
> providers stay independently callable). `rankSignals` excludes stale/invalid/suppressed signals, dedupes
> by key, scores from the documented registries below, and selects **at most one** risk / opportunity /
> recommended move — `null` when nothing clears its threshold (weak items are never promoted to fill a
> slot). APIs (§13) and UI/Home (§3/§12) remain **unimplemented** — later, separately-approved slices.
>
> **Slice 3 status (reviewed and merged to `main`, commit `9f0faec`):** recommendation
> **lifecycle persistence** (§§5/7/8/9) is implemented in `lib/daily/lifecycle.ts` + `lib/daily/fingerprint.ts`
> with migrations `0022` (`daily_recommendations`) + `0023` (`supersede_daily_recommendation` plpgsql
> function for **genuinely-atomic** supersession — one `SELECT` statement, all-or-nothing), verified by
> `scripts/verify-daily-slice3.ts` (62/62). Cooldowns are **exclusive** (reject/not_relevant eligible on
> `respondedDate + 14`/`+ 90`; defer inclusive through `deferUntil`, eligible +1). It
> persists only the lifecycle of a recommended move: `presentRecommendation` (present/reuse/supersede),
> `respondToRecommendation` + `correctResponse` + `reopenRecommendation` (owner responses), `getSuppression`
> / `loadSuppressedKeys` (suppression + recurrence: accept while active; defer through `deferUntil` inclusive;
> **reject 14-day** + **not_relevant 90-day** cooldowns; completed unchanged; a materially-changed
> fingerprint un-suppresses/supersedes), and a read-only `runDailySelection` coordinator (writes only when
> `present: true`). A stable sha256 `signalFingerprint` (material fields only; order-independent; excludes
> timestamps/prose/randomness) distinguishes "same condition re-shown" from "materially changed". Owner-scoped;
> supersession is atomic-safe (deactivate-then-insert-then-link) with the live-only partial unique index as
> the race guard. **APIs (§13), UI/Home (§3/§12), AI (§11), notifications, and automated verification jobs
> remain unimplemented.**
>
> **Slice 2 constants (approved registries + thresholds):**
> - **Risk base weights:** projected_shortfall 40, payment_overdue 38, bill_overdue 36, cash_flow_conflict
>   34, obligation_overdue 30, task_overdue 28, collection_unverified 26, bill_due_soon 24, payment_due_soon
>   24, utilization_high 22, obligation_due_soon 20, task_due_soon 18, recent_hard_inquiries 16,
>   tight_cash_before_payday 16, stale_credit_score 10, uncategorized_transactions 8, pending_matches 8.
> - **Opportunity base weights:** spending_opportunity 28, credit_action 26, utilization_progress 18,
>   collection_resolution_progress 18, goal_progress 14, planned_experience 10, uncategorized_transactions
>   8, pending_matches 8. Opportunities require **medium/high** confidence.
> - **Components:** urgency high +20 / med +10 / low +0; deadline overdue>7d +20, overdue 1–7d +18, today
>   +16, tomorrow +12, 2–3d +8, 4–7d +4, later/null +0; confidence high +10 / med +5 / low +0;
>   actionability +8; freshness today +4 / ≤7d +2 / older +0; capacity fit affordable +5 / unknown +0 /
>   tight −8 / unsafe → excluded; friction money (≤$25 −1, ≤$100 −3, >$100 −6) + time (≤15m 0, ≤30m −1,
>   ≤60m −3, >60m −5) using **structured** cost/minutes only (never free-text).
> - **Scores:** riskScore = base+urgency+deadline+confidence+freshness (min **40**); opportunityScore =
>   base+urgency+confidence+freshness+actionability+friction (min **35**). **moveScore = max(riskScore,
>   opportunityScore) + capacityFit**, **single-counting** actionability + friction: those two are already
>   inside `opportunityScore`, so for an **opportunity-based** move they are NOT re-added (moveScore =
>   opportunityScore + capacityFit); for a **risk-based** move (riskScore lacks them) they are added
>   **exactly once** (moveScore = riskScore + actionability + friction + capacityFit). On a tie the base is
>   taken from the opportunity (so nothing is double-counted). The move breakdown records `baseFrom`
>   (`risk`|`opportunity`) + `actionabilityInBase`/`frictionInBase`, and components sum exactly to the
>   total. Move min **45**. Tie-break: urgency → nearer/overdue deadline → confidence → lower money → lower
>   time → key asc.
> - **Qualifying move base:** a source score may become the move base **only when that source evaluation is
>   eligible** — risk only when `risk.eligible`, opportunity only when `opportunity.eligible`. Risk/opportunity
>   keep diagnostic numeric scores when they fail thresholds/eligibility, but those diagnostic scores must
>   **not** become a valid move base (a below-threshold or low-confidence source cannot become a move via
>   actionability/capacity points). If neither source qualifies, the move is ineligible with the
>   `no_qualifying_risk_or_opportunity_base` exclusion; below-threshold source diagnostics are preserved in
>   their own evaluations.
> - **Diversity:** start from the highest-scoring qualifying opportunity; prefer the highest
>   different-domain-than-risk opportunity **only when it is within `DIVERSITY_NEAR_POINTS` (10) of the top**
>   — a >10-pt-weaker different-domain candidate never displaces the stronger top; a below-threshold
>   candidate is never chosen for diversity. Additionally, a nonfinancial candidate within **10 points** of
>   a selected financial-family item is preferred where semantically eligible, but a high-urgency financial
>   risk is never displaced cosmetically. `reasonSelected` records whether diversity changed the pick.

## 4. Unified signal contract (read-only)

A common, **read-only** shape every existing service can produce **without changing its stored data**. This
is a calculated view (like insights/credit today), not a table. Providers map their domain output into it.

Proposed shape (`DailySignal`):

| Field | Meaning |
|---|---|
| `key` | Stable deterministic key: `{domain}:{signalType}:{entity}` (drives dedupe + lifecycle linkage). |
| `domain` | `tasks` \| `obligations` \| `bills` \| `finance` \| `credit` \| `spending` \| `goals` \| `data_quality` \| `experience`. |
| `signalType` | e.g. `overdue`, `due_soon`, `projected_shortfall`, `unverified_collection`, `high_utilization`, `reduce_merchant`, `uncategorized_gap`, `goal_progress`. |
| `class` | **Provenance discriminator** (see below): `observed_fact` \| `deterministic_calc` \| `inferred_interpretation` \| `recommendation`. |
| `title` | Short human title. |
| `summary` | One–two sentence plain-English summary. |
| `evidence` | Human-readable evidence string (no secrets). |
| `sourceRefs` | Structured references: `[{ table/service, id }]` — never raw payloads/tokens. |
| `observedDate` | When the underlying fact was observed/current. |
| `effectiveDate` | Deadline / due date / when it becomes relevant (nullable). |
| `urgency` | `low` \| `medium` \| `high` (deterministic mapping). |
| `confidence` | `low` \| `medium` \| `high`. |
| `estimatedUpside` | Bounded string/number (nullable). |
| `estimatedDownside` | Risk if ignored (nullable). |
| `estimatedCost` | Money required (nullable). |
| `timeRequired` | Rough effort (nullable). |
| `reversibility` | `reversible` \| `hard_to_reverse` \| `irreversible` (v1 excludes irreversible actions). |
| `capacityReqs` | `{ money?: number, timeMinutes?: number, scheduleConflict?: boolean }` (nullable/unknown). |
| `requiredVerification` | What the owner must confirm before/around acting. |
| `candidateAction` | The bounded next action this signal implies (nullable for pure facts). |
| `staleDate` | When this signal should no longer be trusted/shown. |
| `reasonCodes` | Machine-readable codes for why it fired (reuse existing insight/credit reason codes). |

**Provenance must not be collapsed.** `class` explicitly distinguishes:
- **observed facts** (e.g. "bill due 2026-07-05", "score entered 700 on date"),
- **deterministic calculations** (e.g. "utilization 47%", "estimatedRemaining $180"),
- **inferred interpretations** (e.g. "this looks recurring"),
- **recommendations** (e.g. "consider lowering utilization").

The brief and every recommendation must be traceable through `sourceRefs` + `class` back to the source
record. No untraceable composite objects.

---

## 5. Prioritization model (deterministic, inspectable)

**No opaque AI ranking in v1.** Selection must be deterministic and reproducible. It **extends the existing
`lib/briefing.ts` approach** (dated reasons, tiers, `datedReason` ranks) rather than replacing it.

**Inputs considered:** urgency; consequence of inaction (downside); deadline proximity (`effectiveDate`);
estimated upside; confidence; time required; money required; reversibility; current cash-flow capacity
(§10); schedule conflicts; whether already being handled (an open recommendation covers the same `key`);
whether the owner previously rejected/deferred a similar `key`; data freshness (`staleDate`).

**Scoring approach (transparent, weighted, integer-stable):**
- Compute a bounded integer score per signal from documented components (e.g. deadline/urgency dominate,
  then downside×confidence, then upside×confidence, minus friction from cost/time when capacity is tight).
- The exact weights live in a single documented constants block (like `THRESHOLDS`/`TYPE_PRIORITY` in
  insights) so ranking is inspectable and change-controlled.
- Every candidate exposes its component contributions for "why chosen" (§6 `reasonOutranked`).

**Tie-breaking:** higher urgency → nearer deadline → higher (downside×confidence) → higher upside →
lower cost → stable `key` ascending (fully deterministic, no randomness).

**Category caps + diversity:** to prevent Finance/credit from crowding out everything:
- The **risk** and **opportunity** slots may not both come from the same domain unless no other domain has
  a qualifying signal.
- At most **one** signal per `domain` may occupy the risk+opportunity+recommendation slots combined,
  unless fewer than three domains qualify.
- "What changed" and "Today" apply their own per-source caps (§3).

**Suppression & dedupe:** signals with the same `key` are deduped (highest-scoring instance wins). A signal
whose `key` is covered by an **open** recommendation (accepted/deferred not past its defer date) is
suppressed from risk/opportunity/recommendation to avoid re-nagging. A `key` the owner marked **not
relevant** or **rejected** is suppressed per the recurrence rules (§7).

**Stale handling:** signals past `staleDate` are excluded; if the top pick is stale, the next non-stale
candidate is chosen. Stale-but-important classes (e.g. "your score data is old") surface as their own
data-quality signal rather than as a stale substantive signal.

**Explainability:** the selected risk/opportunity/recommendation each record the deterministic reason they
were chosen over alternatives (score + dominant component + which caps/suppressions applied). AI may
*later* rephrase this explanation (§11) but must not change the selection.

---

## 6. Recommended next move (single, bounded)

The one recommendation carries the full Product-Alignment recommendation shape:

- `observation` — what Xanther noticed.
- `whyItMatters` — the consequence/benefit.
- `evidence` — grounded evidence string + `sourceRefs`.
- `personalRelevance` — why it matters *to this owner now* (e.g. "due before your next paycheck").
- `expectedUpside`.
- `tradeoff`.
- `estimatedMoneyRequired` (nullable).
- `estimatedTimeRequired` (nullable).
- `urgency`.
- `confidence`.
- `capacityCheck` — result of §10 (`ok` \| `tight` \| `unknown`) with the basis shown.
- `nextAction` — the bounded, realistic step (owner-performed or an in-app confirmed action already
  permitted, e.g. "open Categorize", "mark this bill paid" via the existing confirmed flow).
- `requiredVerification`.
- `expiration` — when this recommendation goes stale and should be regenerated.
- `reasonOutranked` — deterministic reason it beat the alternatives (§5).

**Hard limits (restating §14):** the action must **never** automatically spend or move money, contact
anyone, publish, apply for anything, accept terms, delete records, or make an irreversible decision. It may
only (a) instruct the owner to do something themselves, or (b) trigger an **already-existing,
owner-confirmed** in-app action (e.g. the existing "mark bill paid" or "confirm match" flows), always
behind explicit confirmation.

---

## 7. Owner response lifecycle

Allowed responses and meanings:

| Response | Meaning |
|---|---|
| `accept` | Owner intends to act; the recommendation stays open and is tracked to a later verify step. |
| `defer` | Not now; hidden until `deferUntil`, then eligible to return. |
| `reject` | Owner declines this specific recommendation; suppressed per recurrence rules. |
| `not_relevant` | The underlying premise doesn't apply to the owner; suppressed more strongly than reject for that `key`/pattern. |
| `complete` | Owner did it; moves to verify/outcome. |

**Fields:** `response` (required); `note` (optional free text); `deferUntil` (required for `defer`);
`completedAt` (set on `complete`); `outcomeNote` (optional, at/after completion); `verificationState`
(`unverified` \| `verified` \| `could_not_verify`).

**Return rules (explicit, inspectable — no ML):**
- `defer` → returns after `deferUntil` if the signal is still true and non-stale.
- `reject` → the exact `key` is suppressed for a documented cooldown window (e.g. N days) and while the
  underlying facts are unchanged; a *materially changed* recomputation (§9) may resurface it with a note
  ("conditions changed since you dismissed this").
- `not_relevant` → the `key` (and, where defined, its `signalType` pattern for that entity) is suppressed
  for a longer documented window; still resurfaces only on material change, clearly labeled.
- `accept`/`complete` → suppress the live signal; schedule the later verify revisit.

**Reversal/correction:** every response is correctable — the owner can change a response (e.g. undo a
`not_relevant`, un-defer, reopen a completed item). Corrections are explicit owner actions, recorded with
timestamps; nothing is inferred or auto-changed.

**No machine learning in v1.** "Learning" = deterministic, inspectable suppression/return rules driven by
recorded responses, not statistical models.

---

## 8. Persistence design (IMPLEMENTED in Slice 3 — migration `0022`)

> **Note (updated for Slice 3):** the design below was proposed during the documentation/design phases,
> which created **no** migration. **Slice 3 is the approved persistence implementation phase** and adds
> migration `0022_new_sprite.sql` (`daily_recommendations`). The earlier "no migration in this phase"
> wording applied to the design phases only; it does not apply to Slice 3.

Persist **only the recommendation lifecycle**, not the source facts (those stay in their domains and are
recomputed). Prefer a **single minimal lifecycle table** plus an optional lightweight brief-log.

**Proposed `daily_recommendations` (lifecycle only):**
- `id`, `userId` (owner-scoped, FK cascade),
- `recommendationKey` (stable `key` from §4 — links a lifecycle row to a regenerable signal),
- `domain`, `signalType`,
- `sourceRefs` (JSON references to source records — **references, not copies**; no secrets/payloads),
- `presentedOn` (date first shown), `presentedCount`,
- `snapshot` (small JSON of the recommendation *as shown*: title/summary/evidence/upside/urgency/confidence
  — for auditability of what the owner saw; not a duplicate of live domain facts),
- `response` (`pending`\|`accept`\|`defer`\|`reject`\|`not_relevant`\|`complete`),
- `responseNote`, `deferUntil`, `completedAt`, `outcomeNote`, `verificationState`,
- `supersededByKey` (when a newer recommendation replaces this one for the same intent),
- timestamps (`createdAt`/`updatedAt`/`deletedAt`).
- Uniqueness: **live-only partial unique** on `(userId, recommendationKey)` where not superseded/deleted
  (following the 1C.0A `0021` lesson — soft-deleted/superseded rows must not block re-creation).

**Optional `daily_brief_log`** (only if change detection needs it): `userId`, `briefDate`, small JSON of
signal keys shown that day (to power "don't re-show unchanged facts" in §9). May be avoidable if §9 can
compare against `daily_recommendations` + domain `updatedAt` alone — decide during implementation.

**Four clearly separated layers:**
1. **Source data** — existing domain tables (tasks, obligations, financial_entries, credit_*, imported_
   transactions, …). Unchanged. Read-only from the DCC.
2. **Calculated signals** — the `DailySignal[]` view, **recomputed per request**, never stored.
3. **Persisted recommendation lifecycle** — `daily_recommendations` (+ optional brief log). The *only* new
   durable state.
4. **Generated daily brief view** — the assembled `DailyBriefView`, **recomputed per request**, never
   stored.

**Recompute vs. store:** recompute signals and the brief; store only lifecycle state and (optionally) the
per-day shown-keys log. **(Slice 3 implemented the `daily_recommendations` lifecycle table via migration
`0022`; `daily_brief_log` was intentionally NOT created — it belongs to later "What changed" work.)**

---

## 9. Change detection ("What changed")

**Definition (v1):** a grounded, material change in a source domain since the last brief. Candidate change
types (all from existing data):
- newly **due or overdue** tasks/obligations/bills (crossed a threshold since last brief);
- obligation date/status changes;
- new or changed bills;
- **new imported financial activity** (`imported_transactions` since last brief);
- **meaningful spending changes** (existing insight change thresholds);
- **changed credit score or utilization** (new snapshot / crossed a band);
- newly **stale** items (e.g. score aged past 45 days) or newly **resolved** items (paid bill, verified
  collection, completed task).

**Comparison window:** since the owner's **last brief** (`daily_brief_log.briefDate` or the most recent
`presentedOn`); if none exists, a bounded look-back (e.g. last 24–72h of `updatedAt`/`postedDate`) rather
than full history.

**Materiality thresholds:** reuse existing deterministic thresholds where they exist (insight change
thresholds, credit bands); define small documented thresholds otherwise (e.g. ignore sub-dollar spending
deltas). Below-threshold deltas are excluded.

**Dedupe / no-repeat:** a change already shown on a prior day is not re-shown while unchanged; comparison is
by `key` + a change-hash of the salient fields. The section shows the change *event*, not the static fact,
so the same unchanged fact never reappears daily.

---

## 10. Capacity awareness (grounded only)

Capacity checks use **only currently available facts**:
- **available / projected remaining cash** — `computeFinancialOutlook.estimatedRemaining`,
  `computeProjection.totals.totalProjectedCash`, `computeCashSummary.totalActualCash`;
- **bills due before payday** — `billsDueBeforePayday`, `nextPaydayDate`;
- **schedule availability** — derived from dated obligations/bills/income/experiences on the day/window;
- **task load** — count of open/overdue tasks;
- **time required** — the signal's `timeRequired`/`capacityReqs.timeMinutes`;
- **deadline conflicts** — overlapping `effectiveDate`s within the window.

A recommendation's `capacityCheck` returns:
- **`ok`** — required money ≤ safe available and no hard schedule/time conflict;
- **`tight`** — required money exceeds a conservative buffer, or a schedule/time conflict exists → the
  tradeoff must warn and must never suggest using rent/essential-bill funds (consistent with 1C.0A);
- **`unknown`** — the needed capacity fact isn't available.

**Explicitly unsupported capacity signals** — mood, sleep, emotional energy, physical health — have **no
grounded data**. The system must render these as **`unknown`** and must **never infer** them. It may not
downgrade or gate a recommendation on an inferred emotional/health state.

---

## 11. AI role (none implemented in this phase)

**First-version boundary:**
- deterministic services establish **facts and ranking** (§4, §5);
- the Daily Command Center **must fully function without AI** — the deterministic brief is the product;
- AI may **later** (separate approved phase) rewrite the deterministic brief into clearer natural language;
- AI may **later** explain *why* an item matters or compare accepted options;
- AI **must not** create unsupported evidence, change ranking invisibly, or perform consequential actions;
- **every AI-generated statement must remain traceable** to structured evidence (`sourceRefs`/`class`);
- **AI failure must fall back to deterministic text** with no loss of core function.

**No AI is implemented in this phase.** When later added, AI is a presentation/interpretation layer over an
unchanged deterministic core, gated by the hard boundaries (§14) and the confirmation rule.

---

## 12. Home integration

**Decision: the Daily Command Center orchestrates and lightly reorganizes Home; it does not blindly rebuild
it.** Home already assembles `needsAttention`, `comingUp`, `money`, `momentum` via `buildHomeView` and the
`lib/briefing.ts` ranker — v1 should reuse those providers, not discard them.

- **Above the fold (new):** the brief's five sections (Today, What changed, One risk, One opportunity, One
  recommended next move) become the **top** of Home — the calm daily briefing.
- **Retained below:** the existing **Money awareness**, **Needs attention**, **Coming up**, and **Life
  momentum** sections remain as the detailed, source-linked area (they already exist and are useful).
- **Consolidated:** where the brief's "Today/One risk/One opportunity" overlap with existing Home lines
  (e.g. the credit/insight one-liners already on Money awareness), the brief becomes the single prioritized
  surface and the duplicated one-liners are removed from the lower sections to avoid double-display.
- **Reaching source modules:** every brief item links to its source module (`/finances`, `/manage`,
  `/experiences`) via `sourceRefs`; "see /finances"-style deep links are preserved.
- **Mobile:** the five brief sections stack; only **Today + the one recommended move** are guaranteed above
  the fold; the rest is a short scroll; no horizontal overflow (consistent with existing responsive rules).
- **Repeated/unresolved recommendations:** an accepted-but-unverified or deferred item shows a subtle
  "in progress / deferred until X" state rather than re-presenting as new; rejected/not-relevant items do
  not reappear except on material change (§7).

Existing Home functionality is preserved; the DCC is an orchestration layer on top, not a replacement.

---

## 13. API & service boundaries (IMPLEMENTED in Slice 4 — `daily-command-center-slice4-review`, awaiting review)

> **Slice 4 status.** The API surface below is **implemented** on the `daily-command-center-slice4-review`
> branch (awaiting review; not merged). It exposes the merged Slice 1–3 engine through owner-scoped server
> APIs and a bounded public view-model. **No migration** was added (guard stays at `0023`); **no UI, Home,
> AI, notifications, background jobs, external calls, or consequential actions.**
>
> **Endpoints (as built) — all `export const dynamic = "force-dynamic"`, all responses `no-store`
> (owner-specific + time-sensitive; never CDN- or cross-owner-cached):**
> - **`GET /api/daily`** — owner-scoped and **READ-ONLY**. It calls the read-only `runDailySelection`
>   **without `present: true`**, so a read never records presentation or mutates lifecycle. This is why GET
>   performs **no lifecycle writes**: presentation is a distinct, deliberate act (below), not a side effect
>   of viewing the brief — a page load, a prefetch, or a bot hitting the URL must not create or bump a
>   recommendation row. Returns the bounded `DailyBriefView` (§below).
>   GET also uses **one** fingerprint-aware suppression result (`suppressedKeySet(run.suppression)`) for
>   both ranking and Today — never a second fingerprint-less lookup — and attaches lifecycle to the selected
>   move **only when the stored `signalFingerprint` matches the current signal's fingerprint** (a
>   prior-condition accept/complete/reject is shown as `null`, never as the new move's state).
> - **`POST /api/daily/recommendations/[key]/present`** — the **explicit presentation-recording** endpoint.
>   The server recomputes the current selection and accepts the key **only if it is exactly the
>   currently-selected recommended-move key**; arbitrary, stale, suppressed, below-threshold, or
>   no-longer-current keys are rejected (409), so the browser cannot invent a key and persist it. Reuses the
>   active row and increments `presentedCount` **exactly once** per accepted request (idempotent). This is
>   also the point at which a materially-changed move supersedes its stale row and returns a fresh pending
>   lifecycle.
> - **`POST …/[key]/respond`** — body `{response, note?, deferUntil?}`; `pending` explicitly **reopens** the
>   active row; `defer` requires a **future** `deferUntil` in `America/New_York`. `deferUntil` is validated
>   with a **strict calendar check** (`isStrictISODate` — rejects impossible dates like `2026-02-29` that
>   lenient `Date.parse` would roll over), is required for `defer`, and is rejected with a non-`defer` response.
> - **`POST …/[key]/outcome`** — body `{outcomeNote?, verificationState?}`; requires the recommendation to be
>   `complete` (else 409); an empty request is rejected (400); verification is a recorded owner/system
>   assertion only — **no automated verification**.
> - **Media type:** the body-bearing mutations (`respond`, `outcome`) require a JSON content type
>   (`application/json`, optional charset); a missing or non-JSON `Content-Type` is rejected with **415**.
>   The `present` route has no body and does not require this check.
>
> **Public `DailyBriefView` shape (`lib/daily/view.ts`) — bounded; never leaks internals:**
> `{date, generatedAt, today{items,empty}, whatChanged{items,state,message}, risk, opportunity,
> recommendedMove, degraded[], lifecycle{activeRecommendation}}`. It never returns raw `CollectedSignals`,
> full ranked arrays, internal duplicate/exclusion diagnostics, DB rows, SQL/stack traces, raw provider
> errors, or secret source records. `capacity ∈ {ok, tight, unknown}` — **`unknown` when available cash is
> unavailable** (never a false "ok"); the move's `personalRelevance` is always `null` (never invented).
> **Today** is max 3 concrete dated tasks/obligations/bills (overdue→today→soon, then urgency, then key),
> suppression-aware and provenance-preserving, empty when nothing qualifies. **`whatChanged`** is always
> `{items:[], state:"not_available", message:"Change tracking is not available until a prior brief baseline
> exists."}` — a **truthful capability boundary**, not an error (no `daily_brief_log` or change detection was
> added in this slice; see §9).
>
> **Ownership:** owner is server-derived (`CURRENT_USER_ID`); request bodies are **strict** — any unlisted
> field (incl. `userId`/`ownerId`/timestamps/row ids/fingerprints/scores/source refs/verification-on-respond)
> is rejected (400); a cross-owner key returns the standard **not-found** (404) with no existence leak.
> **Idempotency** (spec §11) is implemented in the lifecycle service, not just the handlers. **Degraded
> isolation:** one provider failure yields HTTP 200 with surviving sections + a sanitized `degraded[]`.
> Verified by `scripts/verify-daily-slice4.ts` (**66/66**).

- **Signal-provider interfaces** — one read-only provider per grounded domain (`getTaskSignals`,
  `getObligationSignals`, `getBillSignals`, `getFinanceSignals`, `getCreditSignals`, `getSpendingSignals`,
  `getGoalSignals`), each returning `DailySignal[]` and **each independently failable**.
- **Orchestration service** — `collectDailySignals(userId)` calls providers (in parallel), tolerates
  per-provider failure (returns partial + a `degraded` note), and never lets one domain's error erase
  others.
- **Ranking service** — `rankSignals(signals, context)` → deterministic, inspectable ordering (§5),
  reusing/extending `lib/briefing.ts`.
- **Daily-brief view model** — `buildDailyBrief(userId)` → `DailyBriefView` (the five sections + the one
  recommended move + a `degraded` list of domains that failed).
- **Recommendation lifecycle service** — `presentRecommendation` (idempotent create/update by
  `recommendationKey`), `respondToRecommendation` (accept/defer/reject/not_relevant/complete),
  `recordOutcome`, `reverseResponse`.
- **Endpoints (read + explicit-present + respond + outcome; no consequential action):** `GET /api/daily`
  (assembled brief, **read-only** — records nothing), `POST /api/daily/recommendations/[key]/present`
  (explicit presentation recording, current-key only), `POST /api/daily/recommendations/[key]/respond`,
  `POST /api/daily/recommendations/[key]/outcome`. No endpoint performs a consequential action;
  consequential in-app actions reuse the **existing** confirmed routes. **Presentation is recorded only by
  the explicit `present` endpoint — never as a side effect of `GET`** (a view, prefetch, or bot must not
  create or bump a lifecycle row).
- **Ownership/authorization:** server-derived owner (`CURRENT_USER_ID`); every query owner-scoped; the
  browser never supplies a user id, and cross-owner keys return not-found (no existence leak).
- **Idempotency:** `presentRecommendation` and `respond` are idempotent by `recommendationKey`; an explicit
  re-present of the still-current live signal updates `presentedCount` once, not a duplicate row (live-only
  partial unique, §8); idempotency is enforced in the lifecycle service.
- **Timezone:** all date-only logic in `America/New_York` (reuse `lib/time.ts` `localToday`), consistent
  with insights/credit.
- **Failure isolation:** a Finance failure must not erase Tasks/Calendar-derived/Credit sections — the
  brief renders what it can and marks the rest `degraded` (mirrors `buildHomeView`'s `Promise.allSettled`
  per-section resilience).

---

## 14. Safety & privacy (reasserted)

- **Privacy by default**; nothing exposed or published.
- **Server-side ownership filtering**; single-owner; **no cross-user access**.
- **No sensitive evidence in logs** — `sourceRefs` are ids/labels, never raw Plaid payloads, tokens,
  balances-as-secrets, or session values.
- **No hidden external calls**; no network calls added in v1.
- **No action without explicit confirmation.** The DCC never automatically: moves/spends money; contacts
  people; publishes; applies for anything; accepts legal/financial terms; deletes source records; files
  disputes; impersonates the owner; or represents inference as fact.
- Consequential actions are always the owner's, or an **existing** owner-confirmed in-app flow behind
  explicit confirmation.
- Provenance (`class` + `sourceRefs`) makes every shown statement traceable; uncertainty is labeled, never
  hidden.

---

## 15. Acceptance criteria (for the eventual, separately-approved implementation)

1. **Truthful sourcing** — every brief item traces to a real source record via `sourceRefs`; no fabricated
   data; unsupported domains show truthful empty states.
2. **Deterministic ranking** — identical inputs produce identical selection + ordering; "why chosen" is
   inspectable; no AI in selection.
3. **Concise limits** — section caps honored (Today ≤3, What changed ≤3, risk/opportunity/move **at most 1
   each**); total ≤ ~8 actionable items; **never more than one recommended move**.
4. **At-most-one, never-forced move** — the recommended move (and likewise risk and opportunity) appears
   only when a qualifying, grounded, non-stale candidate clears the ranking threshold (§5), capacity check
   (§10), and hard boundaries (§14); otherwise the truthful empty state is shown. **A weak candidate is
   never manufactured or promoted to fill the slot,** and there is never more than one recommended move.
   Test coverage must include the empty/no-qualifying-candidate path, not only the populated path.
5. **Response lifecycle persistence** — accept/defer/reject/not_relevant/complete persist with the required
   fields; correctable/reversible.
6. **Defer & recurrence** — deferred items return after `deferUntil` only if still true; rejected/
   not-relevant respect the documented cooldown and only resurface on material change, labeled.
7. **Evidence traceability** — provenance `class` preserved; observed facts vs. calculations vs. inferences
   vs. recommendations never collapsed.
8. **Graceful partial failure** — one domain's failure degrades only that part; the rest of the brief
   renders; a `degraded` indicator is shown.
9. **Mobile usability** — no horizontal overflow at 375px; Today + the recommended move above the fold.
10. **No duplicated source facts** — lifecycle stores references + a small shown-snapshot, not copies of
    domain facts; the same unchanged fact isn't re-shown daily.
11. **No consequential automation** — verified by boundary checks (no money movement, contact, publish,
    apply, delete, accept-terms).
12. **No AI dependency for core function** — the brief works fully with AI absent/failed.
13. **No regression** — existing Finance, Tasks, Calendar-derived, Goals (credit), and Home workflows and
    their verify suites remain green; existing Home sections still function.

---

## 16. Explicitly deferred work

Not in this design or its first implementation: conversational Xanther interface; voice; autonomous agents;
cross-domain AI generation; relationship intelligence without grounded relationship data; health inference;
career/job discovery; local event/adventure discovery; automatic task execution; external messaging;
Production Plaid changes; money movement; machine learning; hidden personalization; and broad redesign of
unrelated modules.

---

## 17. Implementation slicing recommendation (proposed — NOT approved)

A safe, independently reviewable sequence. **None of these is approved; each requires its own bounded
HANDOFF task.**

**Testing is not deferred to the end. Every slice ships with tests for the behavior it introduces**, so
each slice is independently verifiable and reviewable. The final verification slice (7) remains responsible
for **comprehensive integration, regression, and browser testing across the whole loop**, but per-slice
behavior must already be covered by that slice's own tests — testing must **not** be postponed until slice
7. A slice is not "done" until its own tests pass and existing suites remain green.

1. **Signal contracts + deterministic providers** — define `DailySignal`, implement read-only providers
   over existing services; verify each provider is pure/owner-scoped and mutates nothing. **✅ IMPLEMENTED
   · REVIEWED · MERGED TO `main`** (`lib/daily/contract.ts`, `lib/daily/providers.ts`;
   `scripts/verify-daily-slice1.ts` = 81/81; commit `0e64a64`; review branch deleted).
   - **Tests in this slice:** provider **purity** (no writes to any source table — snapshot before/after),
     **ownership** (owner-scoped; no cross-user leakage — an owner's row never surfaces for another user;
     generic advice for an empty profile carries only null-id refs), and **mapping correctness** (domain
     output → `DailySignal` fields, including `class`/provenance and `sourceRefs`), plus
     empty-domain/empty-state mapping.
2. **Orchestration + ranking** — `collectDailySignals` (failure-isolated) + `rankSignals` (deterministic,
   extends `lib/briefing.ts`). **✅ IMPLEMENTED · REVIEWED · MERGED TO `main`** (`lib/daily/orchestrator.ts`,
   `lib/daily/ranking.ts`; `scripts/verify-daily-slice2.ts` = 73/73; commit `71ff495`; review branch deleted).
   - **Tests in this slice:** **deterministic ranking** (identical inputs → identical order), **tie-break**
     rules, **category caps**, **diversity** (Finance can't crowd out other domains), **suppression/dedupe**,
     **stale-signal handling**, the **at-most-one / no-forced-item** behavior (including the empty/no-
     qualifying-candidate path), and **partial-failure isolation** (one provider throwing degrades only its
     part).
3. **Lifecycle persistence** — the minimal `daily_recommendations` table with a dedicated migration;
   live-only partial unique; foreign-owner rejection. **✅ IMPLEMENTED · REVIEWED · MERGED TO `main`**
   (`lib/daily/lifecycle.ts`, `lib/daily/fingerprint.ts`, migrations `0022` + `0023` (atomic-supersession
   function); `scripts/verify-daily-slice3.ts` = 62/62; commit `9f0faec`; review branch deleted).
   (`daily_brief_log` intentionally NOT created.)
   - **Tests in this slice:** **migration** applies additively; **lifecycle** transitions
     (present → accept/defer/reject/not_relevant/complete → outcome/verify); **uniqueness** (live-only
     partial unique; soft-deleted/superseded rows don't block re-creation); **owner isolation**
     (foreign-owner rejected); and **recurrence** (defer-until return, reject/not-relevant cooldown,
     resurface-only-on-material-change).
4. **Secure read/present/respond/outcome APIs** — `GET /api/daily` (read-only), explicit `present`,
   `respond`, and `outcome` endpoints; bounded public view-model; idempotency; ownership. **✅ IMPLEMENTED ·
   AWAITING REVIEW** on the `daily-command-center-slice4-review` branch (`app/api/daily/**`,
   `lib/daily/view.ts`, `lib/daily/api-helpers.ts`, lifecycle additions; `scripts/verify-daily-slice4.ts` =
   66/66; **no migration** — guard stays `0023`). See §13 for the as-built surface.
   - **Tests in this slice:** endpoint **read** shape (bounded `DailyBriefView`; no raw internals) + GET
     **read-only** (zero lifecycle writes), **present** (current-key-only, arbitrary/stale/suppressed
     rejected, idempotent single increment), **respond/outcome** happy paths + validation errors,
     **idempotency** by `recommendationKey` (enforced in the service), **ownership/authorization**
     (server-derived owner; browser cannot supply a user id; cross-owner → not-found), **truthful
     `whatChanged: not_available`**, `no-store`, and graceful-degradation (HTTP 200 + sanitized `degraded[]`)
     when a domain is unavailable.
5. **Daily Command Center UI** — the five sections + **at most one** recommended move; empty states;
   response controls.
   - **Tests in this slice:** section rendering + **caps/empty-state** rendering (including the no-move
     path), response controls (accept/defer/reject/not_relevant/complete) and their error surfacing,
     evidence/provenance display, and **375px** no-overflow.
6. **Home integration** — mount the brief above existing sections; consolidate duplicated one-liners;
   preserve existing sections + deep links; mobile.
   - **Tests in this slice:** brief mounts above the fold; **existing Home sections still function** (no
     regression); duplicated one-liners consolidated (no double-display); deep links intact; mobile
     behavior.
7. **Verification harness + comprehensive testing** — a `verify-daily*.ts` harness plus full integration,
   regression, and browser testing across the whole loop (exact-ID temp records, determinism, lifecycle,
   suppression/recurrence, partial-failure, owner protection, empty-state paths) + desktop/375px browser
   verification; all existing suites remain green. This slice **aggregates and cross-checks** the per-slice
   behavior — it does not introduce testing that earlier slices should already own.
8. **Optional AI explanation layer** — a **later, separately approved** phase: rephrase the deterministic
   brief, gated by §11 (traceable, deterministic fallback, no ranking/behavior change).
   - **Tests in this slice:** AI output remains **traceable to structured evidence**, ranking/behavior is
     **unchanged** by AI, and **AI failure falls back** to deterministic text.

Each slice preserves existing behavior, ships with its own behavior tests, and is reviewable on its own.
