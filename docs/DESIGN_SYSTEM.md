# Design System — Visual Language

> The application-wide look and feel for the Personal Life OS. **Direction is owner-approved**
> (see `docs/DECISIONS.md` ADR-014). Specific token *values*, per-area hues, and artwork are
> **provisional** until ratified or superseded by a dedicated application-wide visual redesign.
> Build features to this language using existing CSS primitives; do **not** re-skin existing
> application areas and workflows outside an approved redesign task.
>
> Durable visual *principles* live in `docs/PRODUCT_VISION.md` (13a/13b) and
> `docs/DESIGN_PRINCIPLES.md`. This document is the detailed system that implements them.

## North star

A dark, immersive **personal command center** — a private world centered on the owner's life:
futuristic, calm, organized, emotionally engaging, and subtly gamified without being childish.
Personal, not corporate. Information-rich without looking like a visible database. AI-assisted
and low-friction, not form-heavy.

Visually inspired by "Life OS Dashboard" **in feel only**; **functionally** more automated,
conversational, and action-oriented. We create an **original** design system and never copy its
branding, artwork, written content, or layouts.

---

## 1. Background & surface hierarchy

Depth is the primary device. A near-black void sits behind layered graphite surfaces; each step
up in elevation is lighter and may carry a hairline and a restrained shadow.

`void` (app background, deepest) → `surface-1` (page container) → `surface-2` (panels) →
`surface-3` (raised / interactive cards) → `surface-4` (popovers / active).

- Elevation is communicated by surface step + 1px hairline + soft shadow — never by heavy
  borders or bright fills.
- The void should feel atmospheric and quiet; surfaces feel solid and grippable.

## 2. Accent-color roles — two distinct layers

- **Semantic / urgency (cross-cutting).** `act` (critical/overdue, warm), `aware` (soon/high,
  amber), `explore-urgency` (low urgency/info, cool), `good` (positive/complete, green). Carried
  as a **left-edge marker** and small ticks/badges. Never large fills. These keep their current
  meanings across the whole app.
- **Life-area identity (per section).** One signature hue per major life area, used only for
  that area's banner edge, header tick, and icon tint — enough to make areas feel distinct while
  the app stays one coherent system. Identity hues never override urgency semantics inside a
  card.
- **AI accent (luminous).** A single restrained luminous hue reserved for AI-derived/active
  states. Glow is **selective**, never ambient.

**Color discipline (required).** A page has **one dominant life-area identity color at a time**.
Other life-area colors should appear only when genuinely necessary for navigation or real
cross-area context. **Avoid a rainbow-dashboard effect.** Within a single card, at most one
accent moment (either an urgency marker or the area identity — not both competing).

## 3. Typography

System sans (`--sans`) and tabular mono (`--mono`) for figures — **no remote fonts** (keeps the
build offline-safe; see `DESIGN_PRINCIPLES.md`). **System fonts are retained for now;** a custom
display or mono face is **deferred to the application-wide visual redesign.**

Roles:
- `display / figure` — large, `tabular-nums`, for XP, money, counts.
- `section-label` — uppercase, letter-tracked, muted (the existing tier-label style).
- `title` — card/panel headings.
- `body` — default reading text.
- `sub / caption` — secondary detail, muted.

Weight (not color) carries most hierarchy. Body text never uses luminous/neon hues.

## 4. Cards & panels

Compact but readable: `surface-2/3`, rounded via the radius scale, hairline border, optional
left-edge accent (urgency **or** area, per the color-discipline rule). Generous internal rhythm
over dense borders. **One card = one idea.**

## 5. Navigation

A persistent, quiet wordmark + area switcher. Each area's nav entry may carry its identity tint
as a small marker. On mobile, navigation collapses to a compact, thumb-reachable control.
Orientation over ornament. The **current navigation structure is not treated as permanently
fixed** — areas and workflows may evolve.

## 6. AI-state styling

AI-derived content is visually distinct from owner-entered content via the AI accent and
provenance badges ("Interpreted by AI" vs "Manually adjusted", already shipped in the Experience
loop). Defined states:

- **Available** — AI action offered (e.g., "Help me plan this").
- **Working** — a subtle pulse; never a blocking spinner that hides the manual path.
- **Unavailable** — muted; the manual path is foregrounded.
- **Budget-reached** — `aware`/`danger` tone; the manual path is foregrounded.

AI styling always signals **suggestion**, never **fact**. Provenance must stay legible.

## 7. Progress, XP, status & achievement

Restrained gamification: XP figures in tabular mono; level/progress rings or bars; status pills;
achievement chips. Celebratory but not noisy. Color is always paired with a label or icon —
never color alone.

## 8. Controls & forms

**Buttons.** Tiers: **primary** (filled accent), **secondary** (outline — `.btn-secondary`,
already shipped), **ghost/tertiary**, **destructive**. All states defined (hover/active/disabled);
**focus is always visible**.

**Forms & progressive disclosure.** Default to **summarized + expandable**, not walls of fields.
The "Review details" disclosure is the canonical pattern. Prefer conversational/low-friction
capture; reveal structure on demand. Avoid form-heavy screens.

## 9. Imagery & original artwork

Major life areas may carry an **atmospheric original banner**, low-contrast with a gradient scrim
so text stays AA-readable.

**Permitted media (any, as long as the mood is coherent):**
- original **pixel art**;
- **atmospheric illustration**;
- **abstract environmental artwork**;
- **future subtle animated scenes** (motion-budgeted, reduced-motion aware).

The consistent requirements across all media are: a **coherent mood and palette**, **originality**,
**performance**, and **accessibility**.

Rules:
- **Original only.** No copied, traced, or proprietary assets from "Life OS Dashboard" or any
  source; no third-party logos/characters. Record provenance/license for anything added.
- **Decorative, never informational.** No data lives only in an image. Banners must degrade to a
  CSS gradient with zero loss of meaning.
- **Readable first.** Always scrimmed to preserve AA text contrast; never push primary actions
  below the fold or obscure content.
- **Performance-budgeted.** Optimized formats, responsive sizes, lazy-loaded, mobile-weighted;
  no layout shift; never blocks interaction. Animated scenes must respect `prefers-reduced-motion`
  and stay within a strict motion/perf budget.
- **Restrained.** At most one atmospheric banner per area view; no decorative imagery inside
  action cards.

## 10. Motion & transitions

Subtle, purposeful, fast (≈150–250ms, ease-out). Motion aids orientation (disclosure, state
change) — it never decorates idly. All non-essential motion is disabled under
`prefers-reduced-motion`. No constant glow or looping animation outside an explicitly
motion-budgeted, accessibility-aware animated scene.

## 11. Accessibility & contrast

- WCAG **AA**: ≥4.5:1 body text, ≥3:1 large text and UI/graphical elements (icons, focus rings,
  status ticks).
- **Never color alone** — urgency and area hues are always paired with a label or icon (critical
  given red/amber/green usage and color-vision deficiency).
- **Visible focus** on every interactive element; logical tab order; semantic HTML/ARIA for
  disclosures, badges, and AI-state controls.
- Respect `prefers-reduced-motion` and `prefers-contrast`.
- Luminous/neon hues are accents only — never body text.
- Tap targets ≥44px; banners and motion never trap focus or distract from the manual path.

## 12. Mobile behavior

Single-column stacks, ≥44px tap targets, safe-area aware, banners scale/crop gracefully,
disclosures collapsed by default. Mobile is a first-class layout, not a shrunk desktop.

## 13. Anti-clutter & anti-corporate rules

**Anti-clutter.** Every decorative element must earn its place by aiding orientation or emotion.
Nothing competes with primary content. One accent moment per card. Whitespace is a feature. If a
flourish doesn't help the owner act or orient, remove it.

**Anti-corporate / anti-form-heavy.** No grids of identical KPI tiles; no dense tables as the
default view; no multi-field forms shown before they're needed; no generic stock iconography.
The product reads as **the owner's private world**, not an admin console.

---

## 14. Life-area visual identities

One coherent dark app; each area gets an identity hue + emotional theme + artwork mood. Hues are
accents (edge / tick / icon / banner scrim), not fills. Apply the **color-discipline rule**: one
dominant identity color per page.

| Area | Identity (start) | Emotional theme | Artwork mood |
|---|---|---|---|
| **Home / Today** | warm champagne `#e8c878` (neutral anchor) | grounded, calm command | soft dawn horizon, low contrast |
| **Experiences** | restrained **cyan→violet exploration palette** | discovery, scenery, nightlife, creativity, possibility | atmospheric scenery, dusk/neon cityscapes, dreamlike vistas |
| **Money** | emerald `#3fb47a` (`good` family) | steady, in-control | quiet geometric / topographic |
| **Career & work** | bronze/amber `#d8943f` | momentum, ambition | structural, architectural lines |
| **Health** | mint-cyan `#4fd0b0` | vitality, renewal | organic, breathing forms |
| **Projects & creation** | violet `#b06cf0` | flow, making | workshop / constellation motifs |
| **Relationships & family** | warm rose `#f08aa0` | warmth, connection | soft, human, hearth-like |
| **Personal identity & portfolio** | gold `#e0b24f` | pride, curation | gallery / spotlight, refined |

**Implemented:** the **Home / Today** page (`/`, Home 1A) is the first surface to apply this system
— a `--home: #e8c878` champagne identity (date eyebrow, section ticks, a subtle static dawn
atmosphere), near-black void + graphite cards, urgency reasons as small **text-labelled** pills
(act/aware/good), compact sections, and a 375px single-column layout. No artwork yet (CSS
atmosphere only).

**Experiences palette note.** Experiences uses a restrained gradient from cyan toward violet
(suggesting discovery, scenery, nightlife, creativity, and possibility) rather than a generic
informational blue. It must remain **distinct from the urgency colors** (`act`/`aware`/
`explore-urgency`/`good`) so AI/area atmosphere is never confused with status. Where the cyan→violet
range risks colliding with the cool urgency tone or the AI accent, bias toward violet/magenta.

Per-area rules: each area uses **its identity hue + the shared urgency layer**; never two identity
hues competing in one card; desaturate enough to sit in the dark system; verify every hue against
text/contrast before adoption.

---

## 15. Initial token recommendations

Additive and back-compatible: keep the existing `--ink` / `--panel` / `--panel-2` / `--act` /
`--aware` / `--explore` / `--good` as **aliases**; introduce semantic names. Values below are
starting points to ratify (all dark-system, AA-checked before adoption). **No CSS is changed by
this document** — these are recommendations for a future, separately approved implementation.

```css
/* Surfaces (depth ladder) */
--void:        #07090c;   /* app background (deeper than today's --ink) */
--surface-1:   #0e1116;   /* = current --ink; page container            */
--surface-2:   #161b22;   /* = current --panel; panels                  */
--surface-3:   #1c232c;   /* = current --panel-2; raised cards          */
--surface-4:   #232c37;   /* popovers / active                          */
--line:        #283039;   /* hairline (unchanged) */
--line-strong: #3a4452;   /* emphasis hairline */

/* Text */
--text: #e6eaf0;  --muted: #8b96a6;  --muted-dim: #5c6675;  /* (unchanged) */

/* Semantic / urgency (unchanged hues) */
--act: #f0654a;  --aware: #e0a23b;  --explore-urgency: #5b9be3;  --good: #4fb477;
--danger: var(--act);  --info: var(--explore-urgency);

/* AI / luminous accent (restrained) */
--ai:      #8f9bff;   /* soft indigo — distinct from the cool urgency blue */
--ai-glow: color-mix(in srgb, var(--ai) 30%, transparent);

/* Life-area identity (accents only; ratify per §14) */
--area-home:     #e8c878;
--area-money:    #3fb47a;
--area-career:   #d8943f;
--area-health:   #4fd0b0;
--area-projects: #b06cf0;
--area-people:   #f08aa0;
--area-identity: #e0b24f;
/* Experiences uses a cyan->violet gradient, not a single flat hue: */
--area-exp-from: #36d4e0;  /* cyan */
--area-exp-to:   #9b6cf0;  /* violet */

/* Elevation + motion */
--radius: 10px;  --radius-sm: 7px;  --radius-lg: 16px;   /* extends current --radius */
--shadow-1: 0 1px 2px rgba(0,0,0,.4);
--shadow-2: 0 6px 20px rgba(0,0,0,.45);
--motion-fast: 160ms;  --motion-med: 240ms;  --ease: cubic-bezier(.2,.7,.2,1);
```

> Note: the current code uses `--explore` for the cool urgency accent. The rename to
> `--explore-urgency` above is a **recommendation** to avoid confusion with the Experiences area
> identity; it would be applied (with an alias) only during an approved implementation, not now.

---

## How this guides Build 2B (no implementation here)

Build 2B builds its UI **to this language using existing/defined primitives** (cards, the
"Review details" disclosure, `.btn`/`.btn-secondary`, provenance badges, AI-state conventions):

- **Interpreted request summary** → AI-state summary card (AI accent + provenance badge +
  deterministic summary).
- **Recommendation cards** → compact cards carrying the Experiences identity edge; tabular
  **cost/duration** chips; one primary "Choose" action.
- **"Why this fits"** → an explanation block styled as an AI suggestion (PRODUCT_VISION principle 7:
  recommendations are explained).
- **Assumptions / verification warnings** → `aware`/`danger` warning styling, clearly secondary to
  the recommendation.
- **Choosing an experience** → primary action; **automatic plan creation** → clear, owner-confirmed
  success/transition feedback.
- **AI-unavailable / budget-reached** → the defined unavailable/budget-reached states with the
  manual path foregrounded.

**Deferred to a separate application-wide visual redesign:** creating/placing artwork and banners;
rolling out per-area theming across the app; re-skinning existing application areas and workflows
and the dashboard home; navigation overhaul; any font change; a full motion system; and the global
surface-ladder/token rollout beyond what Build 2B's own new screens use.
