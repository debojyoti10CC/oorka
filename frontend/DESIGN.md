# Oorka design system

Design intent, in one sentence: a clean, playful, light interface that makes a live on-chain competition legible at a glance and lets developers and LPs act on it with keyboard, pointer or touch.

Foundations are adapted from the Stick It Up token set (stickitupx.com), applied to Oorka's three surfaces: the landing page (`#/`), the arena dashboard (`#/arena`) and the docs (`#/docs`). Every value below exists as a CSS custom property in `src/styles.css`. Components must reference tokens, never raw values.

---

## 1. Context and goals

- **Audience:** hookathon judges, developers and LPs. They are technical, they skim, and they verify claims.
- **Surfaces:** a marketing-style landing page, a dense real-time dashboard, and a long-form docs page.
- **Goals:**
  1. Every number on screen must be readable and traceable to the chain.
  2. Every action must be reachable and operable by keyboard.
  3. The system must stay consistent: no one-off spacing, type or colour.
- **Accessibility target:** WCAG 2.2 AA.

## 2. Design tokens and foundations

### 2.1 Color (semantic)

The theme is light and playful: a white canvas, near-black text, black pill CTAs, pastel gradient bento cards and die-cut sticker illustrations.

| Token | Value | Use |
|---|---|---|
| `--color-surface-base` | `#ffffff` | Page canvas, live strip, swap card |
| `--color-surface-muted` | `#fafafa` | Cards and panels |
| `--color-surface-subtle` | `#f4f4f5` | Inputs, hovered rows, code |
| `--color-surface-emphasis` | `#e9e9ec` | Badges, token chips |
| `--color-surface-raised` | `rgba(255,255,255,0.9)` | Sticky nav (over a backdrop blur) |
| `--color-text-primary` | `#171717` | Headings, body, values (17.9:1 on white) |
| `--color-text-secondary` | `#52525b` | Labels, captions (7.7:1) |
| `--color-text-tertiary` | `#a1a1aa` | Decorative only, never body copy |
| `--color-text-inverse` | `#ffffff` | Text on `--color-action` |
| `--color-action` / `-hover` | `#0a0a0a` / `#27272a` | Primary CTAs (black pill) |
| `--color-accent` | `#ffbe25` | Fills only: price pill, seat badge, highlighter, bars |
| `--color-accent-text` | `#a15c00` | Accent as text or lines (5.0:1 on white); yellow text is never used |
| `--color-border-default` / `-strong` | `rgba(0,0,0,.08)` / `.16` | Dividers, outlines |
| `--color-focus` | `#2563eb` | Focus ring (visible on white and on every pastel) |
| `--color-success` / `--color-danger` | `#15803d` / `#dc2626` | Wins and positive edge; errors and negative edge |
| `--grad-yellow` / `-coral` / `-green` / `-blue` / `-lilac` | pastel vertical gradients | Bento and step cards. Text on them uses `--color-text-primary` or `#3f3f46` |

**Stickers.** Original flat SVGs (crown, coin, pin, bolt, shield, ruler, trophy, spark) in `src/Stickers.tsx`. Each has a 9px white die-cut outline and a soft drop shadow, and tilts on hover. Each one stands for a part of the mechanism. They are decorative (`aria-hidden`) and hidden under 640px.

### 2.2 Typography

- `--font-family-primary`: `Geist, "Geist Fallback", ui-sans-serif, system-ui, sans-serif`
- `--font-family-mono`: `"Geist Mono", ui-monospace, monospace`. Used for numbers, addresses and code.
- Base: `--font-size-base` 16px, weight 400, `--line-height-base` 24px.

| Token | Size | Use |
|---|---|---|
| `--font-size-xs` | 11px | Axis labels, block numbers |
| `--font-size-sm` | 12px | Pills, badges, code |
| `--font-size-md` | 13.5px | Table cells, captions |
| `--font-size-lg` | 14px | Buttons, labels |
| `--font-size-xl` | 15px | Secondary body |
| `--font-size-base` | 16px | Body |
| `--font-size-h3` | 22px | Card titles |
| `--font-size-h2` | 48px (36px under 640px) | Section titles |
| `--font-size-display` | 60px (44px under 640px) | Hero |

Headings use weight 400 with negative tracking (-1.5px on the display size). The only display-size exceptions are the token values above.

### 2.3 Spacing

The scale is 4px-based, with the source's fine steps kept for dense UI:

`--space-1` 2px · `--space-2` 4px · `--space-3` 6px · `--space-4` 8px · `--space-5` 10px · `--space-6` 12px · `--space-7` 14px · `--space-8` 16px · `--space-10` 24px · `--space-12` 32px · `--space-16` 48px · `--space-20` 88px

Every gap, padding and margin must use one of these.

### 2.4 Radius, shadow, motion

- **Radius:**
  - `--radius-xs` 12px: buttons, inputs
  - `--radius-sm` 16px: inner cards, code blocks
  - `--radius-md` 22px: cards, panels
  - `--radius-lg` 40px: hero blocks
  - `--radius-pill` 9999px: pills, badges
- **Shadow:**
  - `--shadow-1`: hairline inset highlight plus 1px drop. Cards.
  - `--shadow-4`: `inset 0 1px 0 rgba(255,255,255,.2), 0 2px 4px rgba(0,0,0,.2)`. Primary buttons.
  - `--shadow-raised`: the live strip.
- **Motion:**
  - `--motion-instant` 150ms: hover and color
  - `--motion-fast` 160ms: press
  - `--motion-normal` 200ms: card lift
  - `--motion-slow` 260ms
  - `--motion-slower` 300ms
  - `--motion-lane` 600ms: lane bars sliding on takeover

  Everything must respect `prefers-reduced-motion: reduce`, which drops animation and transitions to none.

## 3. Component rules

Page density: about 38 links, about 14 buttons, 7 lists and 2 navigation landmarks (top nav, docs table of contents).

### 3.1 Button (`button`, `.btn`)

- **Anatomy:** optional leading icon, then the label, then an optional trailing arrow. Label in `--font-size-lg`, weight 500.
- **Variants:**
  - `primary`: accent fill, inverse text, `--shadow-4`
  - `default`: outline in `--color-border-strong`
  - `ghost`: outline in `--color-border-default`
  - `lg`: larger padding for hero CTAs
- **Spacing:** `--space-4` × `--space-8` padding (`lg`: `--space-6` × `--space-10`). Minimum height 36px, and 44px under 640px.
- **States:**

| State | Rule |
|---|---|
| default | Tokens as above |
| hover | Background `--color-surface-subtle`, or `--color-accent-hover` for primary, over `--motion-instant` |
| focus-visible | 2px `--color-focus` outline with a 2px offset. Must never be removed |
| active | `translateY(1px)` over `--motion-fast` |
| disabled | `disabled` attribute, opacity 0.4, `cursor: not-allowed`, not focusable |
| loading | `aria-busy="true"`: label stays, a 12px spinner is prepended, pointer events off |
| error | The surrounding `.status.err` region announces the message. The button itself is not recoloured |

- **Keyboard:** Tab or Shift+Tab to reach. Enter or Space to activate.
- **Pointer and touch:** the whole box is the target, at least 44×44 on touch.
- **Edge cases:**
  - Long labels must not wrap mid-word; groups wrap as a whole (`flex-wrap`).
  - Actions must be named for the outcome: "Settle epoch 3", not "Submit".

### 3.2 Input and select

- **Anatomy:** a visible `<label>` above the field. Placeholder text never replaces the label.
- **States:**
  - focus-visible: accent ring
  - error: `aria-invalid="true"` sets `--color-danger` on the border, with the message in the status region
  - disabled: opacity 0.4
- **Edge cases:** numeric fields use `inputMode="decimal"`. Invalid amounts surface a readable error, never a raw revert.

### 3.3 Card, panel, step, feature

- **Look:** `--color-surface-muted` surface, a `--color-border-default` border, `--radius-md`, `--shadow-1`. Padding `--space-10` (arena) or `--space-12` (landing).
- **Interactive cards** (`.explore a`):
  - hover: border becomes `--color-accent` and the card lifts 2px over `--motion-normal`
  - focus-visible: the accent ring
- **Overflow:** wide content (tables) must scroll inside the card (`overflow-x: auto`), never the page.

### 3.4 Live strip (landing)

- **Content:** five label and value cells. Values in mono, and the live price in accent.
- **Accessibility:** `aria-live="polite"`.
- **Loading:** an ellipsis placeholder.
- **Error:** the caption reads "Live data unavailable right now."
- **Responsive:** 5 columns, then 3 at 1024px or less, then 2 at 640px or less. Long values truncate with an ellipsis.

### 3.5 Tables (standings, vault vs benchmark, comparison, docs)

- Header: `--font-size-sm`, secondary text, with a strong bottom border.
- Numeric columns: right-aligned mono with tabular numerals.
- Empty state: an explicit sentence ("Nothing yet.").
- Overflow: horizontal scroll inside the container.

### 3.6 Navigation

- Top nav: brand link plus Arena, Docs and GitHub. The current route gets `aria-current="page"`.
- Docs table of contents: sticky on desktop, and a horizontally scrolling row under 640px.
- A "Skip to content" link must be the first focusable element.

### 3.7 Status and toasts

- The `.status` region uses `role="status"`.
- Busy messages use secondary text, success uses `--color-success`, and error uses `--color-danger`.
- Messages are full sentences that say what happened and what to do next.

### 3.8 Lanes chart (SVG)

- `role="img"` with a descriptive `aria-label`.
- Out-of-range ranges are hatched, so they're distinguishable without color.
- The seat holder is marked by an accent ring, not by color alone.

## 4. Accessibility requirements (testable)

| # | Criterion | Pass / fail check |
|---|---|---|
| A1 | Text contrast | Body and labels must be at least 4.5:1, and large text at least 3:1. Check `--color-text-secondary` on `--color-surface-base` and on `--color-surface-muted` with a contrast checker; both must pass |
| A2 | Focus visible | Tab through every page. Every interactive element must show the 2px accent outline. Fails if any element shows none |
| A3 | Focus not obscured (2.4.11) | The sticky nav must never cover the focused element. `scroll-margin-top` must be at least 80px on targets |
| A4 | Keyboard operable | Every action must be completable with Tab, Enter and Space only, with no traps |
| A5 | Target size (2.5.8) | Interactive targets must be at least 24×24 CSS px everywhere, and at least 44×44 under 640px |
| A6 | Reflow | At 320px wide, no horizontal page scroll. Fails if `document.documentElement.scrollWidth > innerWidth` |
| A7 | Motion | With `prefers-reduced-motion: reduce`, the marquee, pulse and transitions must stop |
| A8 | Names | Every button and link must have an accessible name that states its outcome |
| A9 | Status | Async results must be announced through `role="status"` |
| A10 | Non-color cues | In-range vs out-of-range, and seat vs challenger, must be distinguishable in grayscale |

## 5. Content and tone

Be concise, confident and implementation-focused.

- **Do:** "Settle epoch 3." / "Takeover. Tight Tony won the seat and the vault moved to their range."
- **Don't:** "Submit" / "Something went wrong" / "Click here".
- Numbers carry units: tUSD, tETH, %, blocks.
- Errors say what happened and the fix: "The epoch isn't over yet."

## 6. Anti-patterns (prohibited)

You must not:

- use raw hex values in component CSS (tokens only);
- remove or restyle away the focus outline;
- use text below 4.5:1 for anything a user needs to read;
- use spacing outside the scale, or font sizes outside the type tokens;
- use large white surfaces;
- signal state with color alone;
- use buttons labelled "OK", "Submit" or "Click here";
- let horizontal scroll reach the page body.

## 7. QA checklist

- [ ] All component CSS reads semantic tokens.
- [ ] Every button shows hover, focus-visible, active, disabled and loading correctly.
- [ ] A keyboard-only pass completes connect, deposit, register and settle in the arena.
- [ ] Skip link appears on first Tab and jumps to main content.
- [ ] Contrast checks A1 pass.
- [ ] 320px, 375px, 768px and 1280px widths: no page-level horizontal scroll.
- [ ] Reduced motion stops the marquee, pulse and transitions.
- [ ] Empty states show sentences, and loading shows placeholders.
- [ ] Copy matches section 5.
