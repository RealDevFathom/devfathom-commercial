# DevFathom Studio — Product Design Contract

Status: canonical  
Version: 1.0  
Last reviewed: 2026-07-28

This document is the permanent UI/UX source of truth for DevFathom Hub, including the tenant
workspace, platform control plane, authentication, organization administration, and future
modules. It exists to make new work consistent without rediscovering the product’s visual
language on every task.

## 1. Decision order

When sources disagree, use this order:

1. This contract.
2. The live tenant workspace at `devfathom.localhost`.
3. Semantic tokens and Studio component classes in `src/app/globals.css`.
4. Shared components under `src/components/ui/` and the tenant/platform shells.
5. Historical prototypes and screenshots.

Do not design a second admin theme. Tenant and platform-control screens are two operating modes
of the same product.

## 2. Design thesis

DevFathom Studio is a **spatial operating canvas**:

- **Fog surround** frames the application as a focused object.
- **Paper workspace** keeps dense operational data calm and legible.
- **Ink structure** provides hierarchy, navigation, and decisive actions.
- **Coral signal** marks brand moments, focus, active states, and important exceptions.

The result should feel editorial, precise, composed, and quietly premium. It must not look like a
generic dashboard template.

### Core principles

1. Use whitespace and grouping before adding decoration.
2. Prefer hairline borders and tonal separation to heavy shadows.
3. Use generous rounded geometry for product surfaces; reserve full pills for navigation,
   statuses, avatars, and compact controls.
4. Let typography carry hierarchy. Do not use color as a substitute for structure.
5. Keep coral scarce enough to remain meaningful.
6. Preserve information density without making the interface visually noisy.

## 3. Token architecture

The system has three layers:

```text
Primitive values → semantic purpose → shared component recipe
```

Product code should normally use the semantic or component layer. Raw color values belong only in
the token source in `src/app/globals.css`.

### Primitive palette

| Name      | Light value | Purpose                                |
| --------- | ----------- | -------------------------------------- |
| Fog       | `#e8e8e5`   | Surround outside the application shell |
| Paper     | `#f6f6f3`   | Main canvas                            |
| White     | `#ffffff`   | Cards and raised surfaces              |
| Ink       | `#111110`   | Primary text and decisive controls     |
| Body ink  | `#333330`   | Body copy                              |
| Muted ink | `#6c6c68`   | Supporting text                        |
| Faint ink | `#a3a39e`   | Low-emphasis metadata                  |
| Coral     | `#bd3f2a`   | Brand signal and focus                 |

Dark-theme primitives are already defined under `[data-theme='dark']` in `globals.css`. Do not
recreate theme logic inside a page or component.

### Contrast-checked text tokens (WCAG 1.4.3 AA, WHA-309)

Text tokens must hold at least 4.5:1 on every surface they sit on, including the 10–20% tint
that `StatusPill` and the destructive button put behind their own label. Worst case listed; the
brand logo mark keeps its original `#ff684f` because it is a graphic, not text.

| Token (theme)                                | Value     | Worst measured surface                 | Ratio |
| -------------------------------------------- | --------- | -------------------------------------- | ----- |
| `--accent-brand` (light)                     | `#bd3f2a` | sunken `#f1f1ee`                       | 4.75  |
| `--accent-brand-hover` (light)               | `#a5361f` | sunken `#f1f1ee`                       | 5.90  |
| `--info` (light)                             | `#405c73` | `info/10` over secondary `#f1f1ee`     | 5.38  |
| `--text-muted`, `--muted-foreground` (light) | `#6c6c68` | sunken `#f1f1ee`                       | 4.66  |
| `--warning` via `--amber-600` (light)        | `#785217` | `warning/10` over a `warning/10` tint  | 4.68  |
| `--success` via `--green-600` (light)        | `#42624a` | `success/10` over a `success/10` tint  | 4.61  |
| `--destructive` via `--red-600` (light)      | `#904039` | `destructive/20` over sunken           | 4.63  |
| `--success` (dark)                           | `#a3c8a6` | `success/20` over muted `#30302d`      | 4.65  |
| `--destructive` (dark)                       | `#f0a89f` | `destructive/20` over raised `#2c2c29` | 4.71  |
| `--info` (dark)                              | `#adc9df` | `info/10` over secondary `#30302d`     | 6.18  |

Do not dim a text token with an opacity modifier (`text-muted-foreground/60`); it drops below AA
on both themes. Use a semantic token (`text-success`) instead of a raw palette utility
(`text-emerald-500`) for state figures.

A tenant brand (`tenantBrandTokens` in `src/lib/tenant-brand.ts`) overrides `--primary` and
`--accent-brand` inline, in both themes, with whatever colour the organization saved. Those values
are not contrast-checked. Chrome text that must stay readable for every tenant (the account
avatar initials and the dashboard eyebrow) uses `text-foreground` / `text-text-muted`, not
`text-primary` / `text-accent-brand`.

### Semantic color tokens

| Intent                                       | Required token                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| Page, card, sunken, raised, inverse surfaces | `--surface-*` / `bg-surface-*`                                                       |
| Strong, body, muted, faint, inverse text     | `--text-*` / `text-text-*`                                                           |
| Subtle, default, strong borders              | `--border-*` / `border-border-*`                                                     |
| Main action                                  | `--primary`, `--primary-foreground`, `--primary-hover`                               |
| Brand signal                                 | `--accent-brand`, `--accent-brand-hover`, `--accent-quiet`                           |
| Focus                                        | `--ring` / `ring-ring`                                                               |
| State                                        | `--info`, `--success`, `--warning`, `--destructive`, and matching foreground/background tokens |

Use semantic state tokens for success, warning, error, and information. Never represent a state
with coral merely because it needs attention.

### Geometry and elevation tokens

| Role                      | Token/value                    |
| ------------------------- | ------------------------------ |
| Compact surface           | `--radius-xs: 8px`             |
| Control                   | `--radius-sm: 12px`            |
| Card                      | `--radius-md: 16px`            |
| Major panel               | `--radius-lg: 20px`            |
| Featured panel            | `--radius-xl: 24px`            |
| Desktop application shell | `36px`                         |
| Hairline elevation        | `--shadow-xs`                  |
| Interactive lift          | `--shadow-sm` or `--shadow-md` |

Shadows should be soft and nearly invisible at rest. A border plus tonal surface change is the
default separation model.

### Spacing

Use a 4px base rhythm, with 8px as the normal visible increment. Prefer existing Tailwind spacing
steps. Typical component gaps are 8, 12, 16, 20, 24, 32, and 40px.

Do not invent isolated values unless a visual alignment genuinely requires one.

## 4. Typography

| Role                                                   | Family          | Treatment                                        |
| ------------------------------------------------------ | --------------- | ------------------------------------------------ |
| Display, headings, navigation, body UI                 | Instrument Sans | Precise, compact, editorial                      |
| Data, labels, eyebrows, timestamps, technical metadata | IBM Plex Mono   | Uppercase when used as an eyebrow or table label |

Rules:

- Page titles use tight tracking and approximately `clamp(2.1rem, 4vw, 3.15rem)`.
- Section titles are concise and visually quieter than the page title.
- Body copy usually sits between 14 and 16px with relaxed line height.
- Metadata is 10–12px mono with controlled tracking.
- Numeric ledgers use tabular numbers.
- Do not add another font without changing this contract and the root font setup together.

Font delivery uses `next/font/local` with the 17 unchanged WOFF2 assets from the accepted build, preserving subsets, weights, Latin preloads, fallback metrics, and semantic variables. Full copyright/OFL notices ship at `/licenses/instrument-sans-OFL.txt` and `/licenses/ibm-plex-mono-OFL.txt` through the existing public-assets copy in the Dockerfile; standalone distributions must include `public` and `.next/static`. Original Google binary retrieval URLs, headers, time, and revision were not retained.

The semantic tokens `--font-sans` and `--font-mono` are defined once, in the `@theme inline` block of
`globals.css`, and name the families the `next/font/local` calls pin (`Instrument Sans`,
`IBM Plex Mono`) followed by their metric-matched fallback faces. They are never mapped from the
variables `next/font` generates (`--font-instrument-sans`, `--font-ibm-plex-mono`) and those
variables never reuse a semantic token name: Turbopack fills the generated class with the call's
JavaScript identifier, which matches no `@font-face`, and a token that references itself is a
cycle. `src/app/font-tokens.test.ts` guards both rules.

## 5. Application geometry

### Desktop

- The viewport uses a 22px fog surround from 1024px upward.
- The application is a rounded shell with a 36px outer radius.
- The top bar is 76px high.
- Primary desktop navigation sits directly below the top bar and uses the same horizontal,
  rounded, active-pill grammar in tenant and platform modes.
- The canvas scrolls inside the shell; the browser page itself should not develop horizontal
  overflow.
- Let operational pages use the available canvas. Do not force a narrow marketing-page max width
  onto tables, ledgers, or detail views.

### Mobile and tablet

- Remove the fog gutter and shell radius when space is constrained.
- Replace desktop platform navigation with a real drawer, backdrop, close action, current-page
  state, and grouped navigation.
- Preserve at least 16px page-side padding.
- Tables may scroll inside their own bounded container; the body may not scroll horizontally.
- Actions wrap below headings instead of shrinking labels into unreadable controls.

## 6. Shared UI grammar

Reuse these components before writing new markup:

| Need                                 | Source                                       |
| ------------------------------------ | -------------------------------------------- |
| Tenant shell                         | `src/components/layout/app-shell.tsx`        |
| Platform shell                       | `src/components/platform/platform-shell.tsx` |
| Page title and actions               | `src/components/ui/page-header.tsx`          |
| Section surface                      | `src/components/ui/section-card.tsx`         |
| Primary/secondary/destructive action | `src/components/ui/button.tsx`               |
| KPI or ledger figure                 | `src/components/ui/stat.tsx`                 |
| Status chip                          | `src/components/ui/status-pill.tsx`          |
| Route animation                      | `src/components/motion/page-transition.tsx`  |
| Platform heading/status adapters     | `src/components/platform/platform-ui.tsx`    |

### Component rules

#### Page header

Use one per page. Order: mono eyebrow, clear H1, one-sentence description, optional right-aligned
actions. Do not place an unrelated card above it.

#### Cards and panels

Use a white/card surface, subtle border, 16–24px radius, and deliberate internal padding. Cards
should represent a real content group, not wrap every sentence or field.

#### Buttons and controls

- Use ink for the primary action and neutral paper surfaces for secondary actions.
- The destructive variant must use the destructive semantic token.
- Controls should be at least 44px tall for primary forms and touch-heavy contexts.
- Every interactive element needs hover, focus-visible, active, disabled, and loading behavior
  where applicable.
- Do not place competing primary buttons in the same action group.

#### Status

Use `StatusPill`; include a visible label and dot/icon so color is not the only indicator. Reserve
pill geometry for statuses and compact controls.

#### Tables

- Labels use compact mono uppercase text.
- Text aligns left, numbers right, status consistently, actions right.
- Rows use hairline separators and a subtle hover surface.
- Put responsive overflow on the table container, never the document.
- Pair empty tables with a useful next action or explanation.

#### Navigation

Active state must be unambiguous through fill/position and text, not color alone. Desktop active
items use a smooth shared pill; mobile items use the grouped drawer grammar. Preserve keyboard
focus and `aria-current`.

## 7. Page recipes

### Dashboard

Page header → compact KPI ledger → operational queue → one visually dominant decision/collection
panel → secondary watch list. Prioritize scanning and actionability over chart decoration.

### Registry or data list

Page header with primary action → filters/search → bounded table or card list → pagination/summary.
Keep row actions predictable and avoid hiding critical state in hover-only UI.

### Organization/detail page

Identity and lifecycle status first → tabs or anchored sections → contract/modules/deployment data
→ guarded operational actions. Destructive actions belong in a visually separated section with
clear consequences.

### Form/onboarding page

Page header → grouped form sections → short contextual help → sticky or obvious completion action.
Every input requires a visible label, useful error message, and preserved value after validation
failure.

### Empty, loading, and error states

Use the same card geometry as loaded content. Explain what happened, what remains safe, and the
next available action. Do not leave blank white panels or spinner-only pages.

### Authentication

Desktop uses the split composition: fixed ink brand/positioning panel plus a calm paper form panel.
Mobile collapses to the form without losing the logo, product context, or comfortable spacing.

## 8. Motion

Use the existing `motion/react` dependency and `PageTransition`. Do not add GSAP, Anime.js, or
another animation runtime for ordinary product interactions.

- Micro-interactions: 150–200ms.
- Panel or route transitions: up to 300ms.
- Animate opacity and transforms; avoid layout-heavy animation.
- Motion should communicate continuity, selection, or hierarchy—not decorate idle screens.
- Under `prefers-reduced-motion: reduce`, content must render immediately with no hidden initial
  state, travel, or required animation.

## 9. Accessibility contract

- Normal text contrast: at least 4.5:1; large text and UI boundaries: at least 3:1.
- Every actionable control is keyboard reachable and has a visible focus indicator.
- Icon-only controls require an accessible name.
- Forms require visible labels; errors use `aria-invalid` and descriptive text.
- State is never communicated by color alone.
- Dialogs and drawers trap/restore focus and close with Escape.
- Shells provide a skip link to the main content.
- Support zoom and text reflow without clipping.
- Use semantic headings in order and only one H1 per page.

## 10. Explicit “do not” list

- No gradients, glassmorphism, neon glow, or decorative noise.
- No generic admin-dashboard sidebar dropped into the platform product.
- No return to the old teal/brass “Abyss” palette or Oxanium heading system.
- No raw legacy palette utility in new UI (`abyss-*`, `paper-*`, `brass-*`) when a Studio semantic
  token exists.
- No hardcoded component colors, new fonts, or isolated dark-mode branches.
- No excessive pill-shaped cards.
- No emoji as interface iconography; use the existing Lucide/Fathom icon language.
- No new animation library without an interaction that the current motion layer cannot express.
- No desktop-only implementation.

## 11. Required workflow for every UI change

1. Read this contract.
2. Inspect the matching live tenant/platform screen and the closest shared component.
3. State which existing tokens and components will be reused.
4. Implement all meaningful states: default, loading, empty, error, disabled, and permission-denied
   where relevant.
5. Verify the visual QA matrix below.
6. Update this contract only when the system itself changes—not for a one-off page exception.

## 12. Visual QA release gate

UI work is not complete until the relevant routes pass:

| Check          | Required coverage                                                   |
| -------------- | ------------------------------------------------------------------- |
| Viewports      | 375px portrait, 768px tablet, 1024px laptop, 1440px desktop         |
| Themes         | Light and dark                                                      |
| Motion         | Normal and `prefers-reduced-motion: reduce`                         |
| Keyboard       | Logical tab order, visible focus, Escape behavior                   |
| Layout         | No document horizontal overflow; bounded table overflow only        |
| States         | Loading, empty, error, disabled, active, destructive confirmation   |
| Console        | No hydration, render, accessibility, or client-fetch errors         |
| Product parity | Platform screens visibly belong to the same family as tenant Studio |

Capture screenshots for changes to shells, authentication, navigation, page recipes, or shared
primitives. Run typecheck, lint, tests, and a production build in proportion to the changed scope.

## 13. Governance

- Owner: product and frontend engineering.
- Any change to fonts, core palette, shell geometry, global radius scale, navigation grammar, or
  motion runtime requires updating this file in the same change.
- Shared component improvements are preferred over page-scoped compatibility CSS when the
  migration can be completed safely.
- Temporary exceptions must include a code comment naming the reason and a removal condition.

Historical source material remains in `docs/superpowers/prototype-ref/`, but it is not permission
to reintroduce the former visual system.
