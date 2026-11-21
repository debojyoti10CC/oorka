# Oorka design system

Dark, cinematic and premium. Adapted from an extracted design system (source: stickitupx.com, extracted 2026-11-21) and applied to Oorka's landing page, arena and docs. Tokens live in `src/styles.css` under `:root`.

## 1. Visual theme

- Refined dark mode with muted tones.
- Geist for headings and body, Geist Mono for code and numbers that need alignment.
- Headings at weight 400 with tight negative letter-spacing.
- `#0a0a0a` is the primary canvas.
- One dominant accent, `#ffbe25`, for CTAs, the live price, the seat holder and brand highlights.
- Rounded corners everywhere (9px+ on interactive elements, 16–24px on cards).
- Subtle inset and drop shadows for elevation.

## 2. Color palette and roles

| Token | Hex | Role |
|---|---|---|
| `--color-bg` | `#0a0a0a` | Page background |
| `--color-surface` | `#121212` | Cards and panels |
| `--color-surface-2` | `#18181b` | Raised surfaces, inputs |
| `--color-text` | `#ededed` | Headings and body text (never pure black or white text) |
| `--color-text-secondary` | `#999999` | Muted text, captions |
| `--color-border` | `rgba(243, 234, 255, 0.10)` | Dividers and outlines (`#f3eaff` at low alpha, so dark stays dark) |
| `--color-primary` | `#ffbe25` | Accent: CTAs, live price, seat holder |
| `--color-on-primary` | `#12110f` | Text on the accent |
| Pastel set | `#f3eaff` `#fff1e4` `#eaf2ff` `#e3d3ff` `#ffe0c2` `#cfe2ff` `#fff1c2` | Tints for step numbers and illustrations, used sparingly |

Do not introduce bright white surfaces. They break the dark palette.

## 3. Typography

| Role | Font | Size | Weight | Line height | Letter spacing |
|---|---|---|---|---|---|
| Display | Geist | 60px | 400 | 66px | -1.5px |
| H2 | Geist | 48px | 400 | 52.8px | -1.2px |
| H3 | Geist | 30px | 600 | 36px | -0.75px |
| Body | Geist | 16px | 400 | 24px | normal |
| Small | Geist | 14px | 500 | 20px | normal |
| Code | Geist Mono | 12px | 600 | 16px | normal |

Mobile (under 640px): scale display and H2 to about 80%.

## 4. Components

- **Primary button:** accent fill `#ffbe25`, text `#12110f`, 12px radius, 12px × 16px padding, 14px text.
- **Outline button:** transparent, 0.8px border in `--color-border`, 12px radius.
- **Pill:** fully rounded, 6px × 16px padding, 12px weight 500. Used for the announcement link and status tags.
- **Card:** `--color-surface`, 24px radius, 32–40px padding, low shadow.

## 5. Layout

- Base spacing unit is 4px. Every gap is a multiple (8, 12, 16, 24, 32, 40).
- Max content width 1180px, centered. 16px side gutter on mobile.
- Radius scale: 2px subtle, 8–9px buttons, 16px small cards, 24px cards, 32px hero blocks.

## 6. Elevation

- Low: `inset 0 1px 1px rgba(255,255,255,0.06), 0 1px 2px rgba(0,0,0,0.4)` on cards.
- Raised: `0 8px 32px rgba(0,0,0,0.45)` on the hero stats strip and focused panels.

## 7. Do and don't

Do:

- keep everything dark;
- use `#ffbe25` as the single dominant accent;
- use Geist and Geist Mono;
- stay on the 4px grid;
- round every interactive element.

Don't:

- use sharp corners;
- use pure black text;
- add decorative badges or ribbons that carry no information;
- invent UI patterns the product doesn't need.

## 8. Responsive

| Breakpoint | Width | Behaviour |
|---|---|---|
| Mobile | < 640px | Single column, sections stack, display type at about 80% |
| Tablet | 640–1024px | Two columns where it helps |
| Desktop | 1024–1440px | Full layout |
| Wide | > 1440px | Max-width container, centered |

Touch targets are at least 44×44px on mobile.
