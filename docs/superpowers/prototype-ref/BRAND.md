# DevFathom Hub — Legacy Prototype Brand Reference

> **Historical only.** This document describes the former teal/brass “The Sounding” prototype.
> The canonical product UI/UX contract is now
> [`docs/design-system/DEVFATHOM-STUDIO.md`](../../design-system/DEVFATHOM-STUDIO.md). Do not use
> this file as visual authority for new tenant or platform-control work.

> **"Depth in everything we build."**
> System name: **The Sounding** · Palette: **Fathom**

This file is retained as implementation history for the earlier prototype. Its accompanying
tokens and screenshots remain useful for understanding prior decisions only.

<!-- prettier-ignore-start -->

---

## 1. Philosophy

A deep-water **teal** primary — the color of depth, seriousness, and grounding — sits over a
**warm paper** neutral that reads editorial and high-touch, never cold corporate-tech. A single
muted **brass** accent supplies quiet warmth and craft, and is used *with restraint*: brass
appears rarely and earns its place (active indicators, focus, a key number, the occasional CTA).

Five rules that define the look:

1. **Whitespace is the brand.** Generous spacing by default; calm, wide containers.
2. **Hairlines over shadows.** Most surfaces sit on a 1px border, not a drop shadow. Shadows,
   when used, are soft, low, and cool-toned — never glossy.
3. **Architectural, not pill-shaped.** Small radii (2–8px) on cards, inputs, buttons. Pills are
   reserved for status chips and counts.
4. **Mono carries the data.** IBM Plex Mono — uppercase, wide-tracked — for eyebrows, labels,
   metadata, table headers, timestamps, and numbers. It gives the UI a precise, technical texture.
5. **One brand voice in type.** Oxanium (the wordmark face) for display and headings, so brand
   and product read as one. IBM Plex Sans for comfortable body/UI.

---

## 2. Color

### Core scales
| Scale | Role | Steps |
|---|---|---|
| **Abyss** (deep teal) | primary | `900 #08221F` · `800 #0C2E2C` · `700 #123A38` · `600 #1A4B47` · `500 #245C57` · `400 #3C7A74` · `300 #6AA39C` · `200 #A8CBC6` · `100 #D6E6E3` |
| **Brass** (accent, muted) | accent | `700 #8A5E32` · `600 #A6743F` · **`500 #BC8850` (primary accent)** · `400 #CFA372` · `300 #E2C49E` · `100 #F1E4D2` |
| **Paper** (warm neutral) | surfaces | `white #FDFCF8` · `50 #F7F5EF` · `100 #EFEBE1` · `200 #E3DDD0` · `300 #D2CBBB` |
| **Ink / Slate** (warm grey) | text & lines | `ink-900 #161A19` · `700 #3B423F` · `600 #545B58` · `500 #6E7570` · `400 #939A94` · `300 #BAC0BA` |

### Semantic status (desaturated, restrained)
`green 600 #3E6B52 / 100 #DDE8E0` · `amber 600 #9C7A3A / 100 #EEE5CF` · `red 600 #9A4A40 / 100 #EDDAD6`

### Semantic aliases — **reach for these in product code, not raw scales**
| Token | Light | | Token | Light |
|---|---|---|---|---|
| `--surface-page` | paper-50 | | `--text-strong` | ink-900 |
| `--surface-card` | paper-white | | `--text-body` | slate-700 |
| `--surface-sunken` | paper-100 | | `--text-muted` | slate-500 |
| `--surface-inverse` | abyss-800 | | `--text-faint` | slate-400 |
| `--border-subtle` | paper-200 | | `--primary` | abyss-700 |
| `--border-default` | paper-300 | | `--accent` | brass-500 |
| `--border-strong` | slate-400 | | `--focus-ring` | brass-500 |

### Dark theme (`[data-theme="dark"]`)
Surfaces become deep teal-black: `page #07201D` · `card #0C2E2C` · `sunken #051512` ·
`raised #103734`. Text: `strong #FBFAF6` · `body #C6D8D4` · `muted #8FB1AB` · `faint #5E827C`.
Borders: `subtle #103734` · `default #1A4B47` · `strong #2C605A`. Brass **lightens** to `#CFA372`.
In dark, the primary button inverts to a light teal (`#B8D4CF`) with dark text.

---

## 3. Typography

| Role | Family | Notes |
|---|---|---|
| Display / Headings / **Logo** | **Oxanium** | wide, rounded soft-tech — matches the wordmark |
| Body / UI | **IBM Plex Sans** | clean, legible workhorse |
| Mono / code / data / labels | **IBM Plex Mono** | eyebrows, metadata, numbers, table headers |

**Scale:** xs `12` · sm `14` · base `16` · md `18` · lg `22` · xl `28` · 2xl `36` · 3xl `46` · 4xl `60` · 5xl `76`
**Leading:** tight `1.08` · snug `1.22` · normal `1.5` · relaxed `1.65`
**Tracking:** tight `-0.02em` · snug `-0.01em` · normal `0` · wide `0.04em` · **caps `0.14em` (eyebrows)**

**Roles:** *Display* = Oxanium regular, tight leading, `-0.02em`. *Heading* = Oxanium semibold,
`1.15` leading. *Body* = Plex Sans, relaxed leading. *UI* = Plex Sans medium. *Eyebrow* = Plex
Mono semibold, UPPERCASE, caps-tracking, accent color. *Numbers/stats* = Oxanium semibold,
`tabular-nums`, tight tracking.

---

## 4. Spacing & layout

8px base grid (with 2/4px half-steps): `1=4 · 2=8 · 3=12 · 4=16 · 5=24 · 6=32 · 7=48 · 8=64 · 9=96 · 10=128`.
Containers: `sm 608` (prose) · `md 960` · `lg 1216` (default page) · `xl 1440`.
Page padding: `clamp(1.25rem, 5vw, 4rem)`. Whitespace is generous by default.

## 5. Elevation, radii, motion

**Radii:** `xs 2 · sm 4 · md 6 · lg 10 · xl 16 · pill 999`. Cards use `lg`; inputs/buttons `sm`.
**Borders:** hairline `1px` (default), `1.5px` thick.
**Shadows** (soft, low, cool — `rgba(8,34,31,…)`): `xs / sm / md / lg`, plus a brass focus ring.
**Motion:** `ease-standard cubic(0.4,0.1,0.2,1)`, `ease-out cubic(0.16,1,0.3,1)`; durations `fast 120 · base 200 · slow 360`.

---

## 6. Component conventions

- **Left rail nav** — dark abyss background; wordmark (Oxanium) with a mono sub-label; nav groups
  with mono uppercase group labels; numbered indices *or* architectural icons; active item = raised
  background + a **brass inset bar** (`inset 2px 0 0 accent`); mono count badges.
- **Eyebrows / labels / metadata / timestamps / numbers** — IBM Plex Mono, uppercase, wide tracking,
  faint or accent color.
- **Stat figures** — Oxanium semibold, `tabular-nums`, large, tight tracking.
- **Cards** — `--surface-card`, hairline `--border-subtle`, radius `lg`, generous padding.
- **Buttons** — *primary*: abyss-700 fill, paper text; *ghost*: transparent with `border-default`.
  Small radii, subtle 0.5px press translate.
- **Status pills** (mono, uppercase): `paid → green`, `sent → abyss`, `pending → amber`,
  `overdue → red` — **already aligned to the `InvoiceStatus` enum.**
- **Tables** — mono uppercase headers, hairline rows, hover = `--surface-sunken`, numbers in display font.
- **Cards** for clients & people; people show **utilization bars** (abyss fill on sunken track).
- **Calendar** week grid with typed events (review = abyss, decision = amber, 1:1 = brass).
- **Command palette**, **chat** (channel sidebar + messages + composer), **settings** (rows + switches).
- **Brass discipline:** accents, active states, focus rings, and the occasional key number only.

---

## 7. Module mapping (prototype screen → DevFathom module)

| Prototype screen | DevFathom module |
|---|---|
| Dashboard (hero, stat ledger, revenue chart, engagements, signal feed, context panel) | **Dashboard** |
| Engagements | **Projects** (+ Kanban) |
| Clients (cards + detail) | **Clients / CRM** (+ contracts) |
| Finance (tables + status pills) | **Finance** (invoices / transactions / P&L) |
| Calendar (week grid) | **Meetings** (+ attendance) |
| People (cards + utilization) | **People / HR** |
| Signal (channels + messages + composer) | **Chat** |
| Insight (bars, stacked bars) | **Reports / analytics** |
| Settings / Detail / Movement timeline | **Settings**, project/client/invoice **detail** |
| Command palette | the **Cmd-K** quick switcher |

---

*Configurable surface attributes from the prototype (carry over as optional preferences):*
`data-theme` (light/dark) · `data-density` (default/compact) · `data-type` (sm/lg type scale) ·
`data-accent` (quiet/bold brass) · `data-layout` (side rail / top nav) · `data-icons` (numeric/architectural).

<!-- prettier-ignore-end -->
