# Design Revamp — "The Sounding" (Fathom design system)

**Date:** 2026-06-29
**Branch:** `feat/design-revamp-the-sounding`
**Status:** Approved scope (whole system, autonomous, all toggles). Execution via CTO/QA/Security review roles.

---

## 1. Goal

Bring the entire DevFathom Hub UI to pixel-faithful parity with the **"DevFathom Hub" HTML prototype** (`/Users/Saad/Downloads/DevFathom Hub (1).html`), governed by the canonical **`BRAND.md` + `devfathom-tokens.css`** brand system. The app's **modules and routes stay exactly the same**; only the visual design changes.

Reference assets are committed at `docs/superpowers/prototype-ref/` (BRAND.md, devfathom-tokens.css, and `proto-01…10-*.png` screenshots of every prototype screen).

## 2. Key finding — this is reconciliation, not a rebuild

The app's `globals.css` **already** uses the exact Fathom palette (Abyss `#123a38`/`#0c2e2c`, Brass `#bc8850`, Paper `#f7f5ef`/`#fdfcf8`, Ink `#161a19`), the three brand fonts (Oxanium / IBM Plex Sans / IBM Plex Mono via `next/font`), shadcn/ui (Tailwind v4 `@theme inline`, CVA primitives), and `next-themes`. The deltas are:

1. **Token architecture** — adopt the canonical full numbered scales (`--abyss-*`, `--brass-*`, `--paper-*`, `--slate-*`) + the richer semantic aliases (`--surface-*`, `--text-*`, `--border-*`) **additively**, reconciled with shadcn's names (`--background`, `--card`, `--primary`…). Nothing existing breaks.
2. **Prototype conventions under-applied** — mono eyebrows, stat ledgers (Oxanium `tabular-nums`), mono table headers, status pills, numbered nav + group labels + brass inset active-bar, utilization bars, typed calendar events.
3. **Hardcoded hex drift** — ~140 raw hex instances across ~30 files (chiefly `hover:bg-[#0C2E2C]` ×72 and one-off login/auth colors) → migrate to tokens.
4. **Theming mechanism** — move from `.dark` class to `data-theme`, and add the five configurable surface attributes.

## 3. Principles (from BRAND.md)

Whitespace is the brand · hairlines over shadows · architectural (small 2–10px radii), not pill-shaped · **mono carries the data** · one brand voice in type (Oxanium display, Plex Sans body, Plex Mono data) · brass earns its place (accents/active/focus/key numbers only) · no gradients/glow; shadows are soft, low, cool-toned.

## 4. Approach (chosen)

**Extend the existing stack; do not rip it out.** Keep Tailwind v4 `@theme inline` + shadcn + next-themes + the current `AppShell`/`Sidebar`/`Topbar` component seams. Layer the canonical tokens in additively, restyle the primitives once (so every consumer updates for free), rebuild the shell to the prototype, then roll the conventions through each module. Verify against the prototype screenshots with Playwright.

Rejected: (a) greenfield design-system package — needless churn, the brand already matches; (b) per-page hardcoding — that's the drift we're removing.

## 5. Token architecture

In `src/app/globals.css`:

- **Add full numbered scales** as CSS custom properties on `:root` (abyss/brass/paper/slate/status), copied from `devfathom-tokens.css`.
- **Add canonical semantic aliases** (`--surface-page/card/sunken/raised/inverse`, `--text-strong/body/muted/faint/inverse/on-accent/link`, `--border-subtle/default/strong/inverse`, `--accent*`, `--primary*`, `--focus-ring`, status fg/bg).
- **Reconcile with shadcn names**: keep `--background`, `--card`, `--primary`, `--muted`, `--accent`, `--border`, `--ring`, etc., but point them at the canonical aliases/scales so both vocabularies resolve to one source of truth. Expose new aliases to Tailwind via `@theme inline` (e.g. `--color-surface-sunken`, `--color-text-muted`, `--color-abyss-700`, `--color-brass-500`) so `bg-surface-sunken`, `text-text-muted`, `border-border-subtle` become utilities.
- **Add `--primary-hover` / `--accent-hover`** so the 72 `hover:bg-[#0C2E2C]` sites become `hover:bg-primary-hover`.
- **Type/space/radii/shadow/motion tokens** from the canonical file (scale xs12…5xl76, leading, tracking incl. `--tracking-caps: 0.14em`, radii xs2…xl16, soft cool shadows, motion eases/durations).

## 6. Theming + the five configurable toggles

Drive all surface attributes off `data-*` on `<html>`:

- `data-theme`: `light` (default) | `dark` — switch `next-themes` to `attribute="data-theme"`; rewrite `@custom-variant dark` to `&:where([data-theme=dark] *)`; apply the canonical dark palette refinements (page `#07201D`, primary inverts to light teal `#B8D4CF`, brass lightens to `#CFA372`).
- `data-density`: `default` | `compact` — scales spacing/control heights.
- `data-type`: `default` | `lg` — bumps the type scale.
- `data-accent`: `quiet` (default) | `bold` — brass restraint vs. more brass.
- `data-layout`: `rail` (default) | `top` — left rail vs. top nav.
- `data-icons`: `numeric` (default, prototype) | `architectural` (current lucide icons).

**Mechanism:** a `PreferencesProvider` (client) that reads/writes `localStorage` and applies attributes pre-paint (inline script to avoid FOUC, like next-themes). Persist to the user record (extend `settings` + a tRPC mutation) so prefs follow the account. Each attribute has a CSS block in `globals.css` overriding the relevant tokens. Settings UI exposes all six as segmented controls.

## 7. App shell (to match prototype)

- **Sidebar** (`src/components/layout/sidebar.tsx`): dark abyss rail; Oxanium wordmark + mono "COMPANY HUB" sublabel; **mono uppercase group labels** (WORKSPACE / FIRM) grouping the existing nav items; **numbered indices** (`data-icons=numeric`) or the current lucide icons (`architectural`); active item = raised bg + **brass inset bar** (`box-shadow: inset 2px 0 0 var(--accent)`); mono count badges; user chip pinned bottom (already present). Respect existing RBAC filtering (`adminOnly`/`hrAccess`) and the `usePathname` longest-match active logic. Grouping: WORKSPACE = Dashboard, Projects, Clients, Notes, Email, Meetings, Chat; FIRM = Finance, Team, Reviews, Insights, HR, Audit Log, Settings (final grouping reviewed during build).
- **Topbar**: wide search ("Search the firm, or ask" ⌘K, keep tRPC global search + cmdk palette), theme toggle, Ask-AI, notifications, avatar dropdown. Restyle to prototype; keep breadcrumb store.
- **Page header pattern**: a reusable `<PageHeader eyebrow heading description actions/>` (mono eyebrow → Oxanium heading → muted description) used by every module.
- **Context panel**: dashboard-only right rail (agenda / NEEDS YOU / ON CALL); built as composable cards, not global chrome.
- **Command palette**: keep functionality; restyle to brand.

## 8. Component conventions / primitives

Restyle shadcn primitives once (CVA) so consumers inherit:

- **Button** — primary = abyss fill + `hover:bg-primary-hover`, paper text; ghost = transparent + `border-default`; small radii; subtle press. Remove per-call hardcoded hovers.
- **Card** — `--surface-card`, hairline `--border-subtle`, radius `lg`, generous padding, no glossy shadow.
- **Badge / status pill** — mono uppercase + status dot; map to `InvoiceStatus`/health enums (paid→green, sent→abyss, pending→amber, overdue→red, on-track/at-risk/blocked).
- **Table** — mono uppercase headers, hairline rows, hover = `--surface-sunken`, numbers in Oxanium/mono `tabular-nums`.
- **Input/Select/Switch/Tabs/Tooltip/Dialog/Dropdown** — token-aligned, brass focus ring.
- New primitives: `Eyebrow`, `Stat` (label + Oxanium tabular figure + delta), `FilterChips`, `UtilizationBar`, `SectionCard`, `Mono`/`DataValue`.

## 9. Per-module restyling (modules unchanged)

Prototype screen → module (reference screenshot):
- Dashboard → **dashboard** (proto-01) — hero, stat ledger, recognised-vs-invoiced chart, context panel.
- Engagements → **projects** + board/kanban + import (proto-02) — filter chips, list w/ movement/health/lead/value/progress; bulk actions retained.
- Clients → **clients** + detail (proto-03) — card grid + detail tabs.
- Soundings → **notes** + detail (proto-04) — knowledge/notes surfaces.
- Calendar → **meetings** + detail + call (proto-05) — week grid, typed events.
- Signal → **chat** (proto-06) — channel rail + messages + composer (keep realtime, voice messages).
- Finance → **finance** + invoice print (proto-07) — stat ledger, chart + cash position, invoices table w/ pills.
- People → **team** + detail + **hr** (proto-08) — card grid + utilization bars.
- Insight → **team/stats** + **reviews** (proto-09) — analytics (bars/stacked bars), charts via tokenized colors.
- Settings → **settings** (proto-10) — rows + switches + the six preference controls.
- Apply language by analogy to **email**, **audit-logs**, **api-docs** (no prototype screen).
- **Auth/public**: login, forgot/reset-password, invite, brand, error/not-found — replace one-off hex (`#06090C`, `#8A97A1`…) with tokens, align to brand.

## 10. Execution model (autonomous, role-based)

- **CTO (architect/lead):** owns the foundation + shell, makes design-system decisions, reviews every module PR-style for fidelity + code quality + convention adherence.
- **QA:** per-module verification — `pnpm/npm build` + `tsc` clean, Playwright screenshot vs. the matching `proto-*.png`, no functional regressions (auth gating, tRPC, realtime, RBAC).
- **Security:** reviews all diffs for issues — no broken auth/RBAC gating, no `dangerouslySetInnerHTML`/XSS via restyle, no leaked data in new client components, CSP/headers intact, no secrets. Run `/security-review` on the branch at the end.

**Sequencing:** Foundation + Shell first (sequential, verified) → then modules fanned out (worktree-isolated where parallel) each gated by QA + Security → integrate → final CTO review + `/security-review` + full build/typecheck/visual sweep.

## 11. Verification

- `npm run build` and `tsc --noEmit` clean after each milestone.
- Playwright: render each app route (dev server) and screenshot at 1440×900; compare against `proto-*.png`.
- Accessibility: focus rings (brass), contrast (AA) for text on paper/abyss, reduced-motion respected.
- Dark mode + each toggle visually spot-checked.
- No remaining `[#` hardcoded hex in `src` (grep gate).

## 12. Out of scope / risks

- No data-model or business-logic changes beyond the small `settings`/preferences persistence.
- Keep all existing behavior: auth, RBAC, tRPC routers, realtime/Ably, voice messages, AI assistant, command palette, breadcrumbs.
- Risk: parallel module agents touching shared primitives → mitigate by freezing the foundation before fan-out and isolating module work.
- Risk: visual drift from prototype → mitigate with screenshot verification per module.

## 13. Reference assets

`docs/superpowers/prototype-ref/`: `BRAND.md`, `devfathom-tokens.css`, `proto-01-dashboard.png` … `proto-10-settings.png`. Live prototype served at `http://127.0.0.1:8753/DevFathom%20Hub%20(1).html` (static server during this work).
