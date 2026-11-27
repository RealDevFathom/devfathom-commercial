# Pharmacy dashboard v2: owner screen (design handoff)

Design date: 27 November 2026. Checked against `develop` at `396e265`.

This package holds **one screen**: the owner's dashboard for all branches, at desktop width. Other
roles, edit mode, and the loading, no-permission and not-in-package states are not redesigned yet.
Keep the live behaviour for those (see §6).

## 0. Before you write code

1. Read `AGENTS.md`, then `docs/design-system/DEVFATHOM-STUDIO.md` in full. It is the UI source of truth.
2. This repo's Next.js differs from older versions. Read the guide in `node_modules/next/dist/docs/` first.
3. Reuse the semantic tokens in `src/app/globals.css` and the shared components in `src/components/ui/`.
   Do not copy the prototype's CSS class names (`db-*`) or its hex values into the app.
4. Do not add a chart library. Every chart here is plain `div`s and one SVG ring (§4).
5. Change server code only for the task in §5, and only if asked.

## 1. What's in this folder

| Path | What it is |
|---|---|
| `HANDOFF.md` | This brief |
| `screens/DashV2A1-1440x900.png` | The design, light. This is the reference |
| `screens/DashV2A1-1440x900-dark.png` | The same in dark |
| `screens/DashV2A1-1024x768.png`, `-768x1024-full.png`, `-375x812-full.png` | How the prototype reflows. Not polished designs; use them for the stacking order only |
| `prototype/dashboard-v2.dc.html` | The prototype's source: markup, CSS and sample-data logic in one file. Read it for exact sizes and copy. It needs a design-tool runtime to run, so read it, don't open it |
| `prototype/tokens.css` | The token values the prototype used |

## 2. What changes

Replace the body of `OwnerCommandCentre` in `src/app/(app)/dashboard/pharmacy-dashboard-content.tsx`.
Today it is a `PageHeader`, a "Scope" card with a branch `<select>`, and a two-column grid of
`SectionCard`s that print `Stat` numbers with a "Source: …" line. The new screen shows the same
eight widgets from `PHARMACY_WIDGET_REGISTRY` (`src/lib/pharmacy/dashboard.ts`) as charts.

| Live today | New |
|---|---|
| Eyebrow "Pharmacy workspace", heading "Owner command centre", description line | Heading "Today at {organisation}" or "Today at {branch}", then the date and "figures up to HH:MM" |
| "Scope" card with a branch `<select>` | Segmented control in the heading row: All branches, then one per branch |
| "As of … · source" in mono text | "Live" pill beside the branch control; the time is in the heading's second line |
| Card eyebrow shows the permission key (`reports:financial`) | Removed. Never show permission keys or "Source: …" to staff |
| `Stat` grids | Charts, each with one plain sentence above it |

## 3. Layout

Desktop (≥1181px in the prototype; use the app's `xl` breakpoint): three rows, 16px gaps, inside the
Studio shell. At 1440 × 900 the whole page fits without scrolling.

| Row | Columns | Card height | Cards |
|---|---|---|---|
| 1 | 4 equal | content (about 106px) | Sales today · Margin today · Cash over or short · Refunds today |
| 2 | 2 equal | 300px | Sales and margin by day · Branches today |
| 3 | 4 equal | 244px | Stock about to expire · Money owed · Stock to reorder · Safety and cover |

- Cards: `--surface-card`, 1px `--border-subtle`, radius 20px (`--radius-lg`), padding 18px 20px, `--shadow-xs`.
- Card title 15px/600. The sentence under it is 13px `--text-muted`, with its key figure in `--text-strong` 600.
- All figures use tabular numerals.
- Below `xl`: row 1 and row 3 become 2 × 2, row 2 stacks. Below 640px everything is one column.
- Each row-3 card ends with a text link pinned to the bottom: "See the batches", "Open money",
  "Review orders", "Open safety". Use each metric's `drillThrough` from `pharmacyReports.catalog`.

**Header.** The prototype draws a one-row 56px header with the navigation inside it. That is a
separate, app-wide decision that has not been made. **Keep the existing app shell** and implement
only the page content.

## 4. The cards

Amounts: whole rupees, `Rs 186,420`. Negative: `−Rs 350`. Chart axis labels: `Rs 200k`.
Percentages: one decimal, `22.1%`.

### Row 1: four tiles (widget `trade`)

Each tile: label (13px muted), value (28px/600), one sub-line, and on the end side a 104 × 44px
strip of 14 mini bars (last 14 days, the last bar at full opacity, the rest at 45%), captioned "Last 14 days".

| Tile | Metric | Sub-line | Mini-bar colour |
|---|---|---|---|
| Sales today | `salesMinor` | "**Rs 211,450** all day yesterday" | ink (`--text-strong`) |
| Margin today | `marginMinor` | "**22.1%** of sales" | brand (`--accent-brand`) |
| Cash over or short | `cashVarianceMinor` | Zero: "**Balanced** at the last day close" in `--success`. Otherwise "**Short** at {branch}" or "**Over** at {branch}" in `--destructive` | `--destructive` if not zero, else `--success` |
| Refunds today | `refundsMinor` | "**0.7%** of sales" | `--text-muted` |

### Sales and margin by day

- Stacked bars, one per day: full height = sales (ink), bottom segment = margin (brand).
- Range control: 7 days, 14 days (default), 30 days.
- Today's bar is diagonally striped with an ink outline, because the day isn't over.
- Dashed horizontal line = the daily average of the complete days shown.
- Legend: Sales · Margin (profit before costs) · Today so far · Daily average.
- Sentence: "A normal day brings in Rs 216,600. Sat 31 Oct was the best day."
- Y axis: three or four gridlines at round values. X labels: "T 22" style at 14 days,
  "Wed 4" at 7 days, every fifth date at 30 days.
- Readout under the chart, defaulting to today and updating on hover, focus or tap of a bar:
  "**Today so far** · Sales **Rs 186,420** · Margin **Rs 41,243 · 22.1%** · 86% of a normal day so far".
  For a past day the last part is "5.5% above a normal day" or "… below a normal day".
- Each bar is a `<button>` with an `aria-label` such as "Sat 31 Oct: sales Rs 262,300, margin Rs 58,100".

### Branches today (widget `branches`)

A table with one row per branch and a totals row. Columns: Branch (name, and "49.4% of sales"
under it) · Sales and margin (a pill bar: width = sales relative to the biggest branch, brand
segment = margin) · Sales · Margin % · Lost sales · Expiring in 30 days · Khata overdue.

- Data: `pharmacyReports.branchComparison` rows (`salesMinor`, `marginMinor`,
  `lostDemandEstimateMinor`, `expiryAtRiskMinor`, `khataAgingMinor`).
- Each row is a button. Picking a branch is the same as picking it in the top control; picking it
  again returns to All branches. The picked row gets `--surface-sunken` and a 3px brand edge;
  the others drop to 45% opacity.
- Sentence: "Gulberg brings in 49.4% of today's sales. Pick a branch to see only its figures."
- "Compare branches" links to `/pharmacy/reports/branch-comparison`.

### Stock about to expire (widget `expiry`)

Four columns for `expiryValueMinor30`, `60`, `90`, `180`, heights relative to the 180-day value,
value above each bar, label below ("30 days" …). 30 days = `--destructive`, 60 days = amber,
90 and 180 = neutral grey. Sentence: "**Rs 42,300** of stock expires within 30 days."

### Money owed (widget `finance`)

Three horizontal bars, widths relative to the largest: "You owe suppliers"
(`accountsPayableMinor`, ink), "Customers owe you" (`accountsReceivableMinor`, grey),
"Khata overdue" (`khataAgingMinor`, amber). Sentence: "**4** supplier claims are still open."
(`openClaims`; "1 supplier claim is still open.")

### Stock to reorder (widget `stock`)

Large figure `openStockSignals` (34px) with "medicines low or out of stock", then one bar split by
branch, and a key listing each branch and its count. Sentence: "**17** purchase orders are ready
to review." (`recommendedOrders`). With one branch picked, the other branches' segments dim.

### Safety and cover (widgets `safety`, `coverage`, `exceptions`)

- An 84px ring showing pharmacists on duty, "3/3" in the middle (`pharmacistCoverage`).
- A list with a status dot and count: Pharmacists on duty · Recalls open (`openRecalls`) · Units in
  quarantine (`quarantineUnits`) · Safety checks waiting (`safetyQueue`) · Other problems (the sum
  of the four `exceptions` metrics).
- Dots: `--success` at zero or full cover, amber when above zero, `--destructive` for open recalls
  or a branch with no pharmacist.
- Sentence, first that applies: "1 branch has no pharmacist on duty." / "1 recall is open at
  Gulberg." / "No recalls are open."

## 5. Data: what exists and what doesn't

Everything is read from `pharmacyReports`. No new tables.

| Need | Available today? |
|---|---|
| Today's figures for every tile and row-3 card | Yes: `commandCentre({ from: today, to: today, branchId? })` |
| Branch table | Yes: `branchComparison({ from, to })`. It needs the ADMIN role and `reports:financial` |
| Yesterday's sales (first tile) | Yes: a second `commandCentre` call for yesterday |
| Day-by-day sales, margin, refunds and cash variance for 7, 14 and 30 days | **No.** `commandCentre` returns totals for a range, not a series |
| Reorder count per branch | Only by calling `commandCentre` once per branch |

**Engineering task (ask before doing it):** add a `pharmacyReports.dailyTrade` query that returns
`[{ date, salesMinor, marginMinor, refundsMinor, cashVarianceMinor }]` for a branch scope and up
to 30 days, built on the same reader as `commandCentre`
(`readPharmacyOwnerCommandCentre` in `src/lib/pharmacy/reports.ts`) and behind `reports:financial`.
Until it exists, the fallback is one `commandCentre` call per day (up to 30 requests); don't ship
that without agreeing it.

## 6. Keep from the live screen

- **Permissions.** Without `reports:financial`, the four tiles, the sales chart, the branch table
  and Money owed show no values. Show the existing Restricted state in plain words ("You don't
  have access to money figures."), never the permission key.
- **Edit dashboard.** Keep `getPreferences` / `updatePreferences` and the hide, reorder and
  wide/compact controls. The grid above is the default layout; a hidden widget leaves its slot.
- **Loading, error, no branches, Reports not in package.** Keep today's behaviour; use skeletons
  shaped like the new cards.
- **Other roles.** `pharmacyDashboardDefault(role)` still decides which widgets a role sees.

## 7. Colours

The prototype's values and what to use in the app:

| Meaning | Prototype | In the app |
|---|---|---|
| Sales | `--text-strong` | `--chart-2` |
| Margin | `--accent-brand` | `--chart-1` |
| Neutral bars | `--border-strong` | `--chart-3` |
| Amber (60 days, khata overdue, warnings) | `#c9822b` light, `#e1bc72` dark | Not a token yet. Use `--chart-4` or `--warning`, and check 3:1 contrast against the card in both themes |
| Bad / good | `--destructive` / `--success` | the same |
| Empty track | `--surface-sunken` | the same |

Colour never carries meaning alone: every bar has a text value or label beside it.

## 8. Accessibility

- Charts built from `div`s get `role="img"` and an `aria-label` that states the numbers.
- Bars and branch rows that act are real `<button>`s; toggles use `aria-pressed`.
- The chart readout is `role="status"`.
- Touch targets are at least 44px. Focus uses the app's focus ring.

## 9. Acceptance checks

- [ ] At 1440 × 900 the page matches `screens/DashV2A1-1440x900.png` and does not scroll.
- [ ] Rows are 4 / 2 / 4, cards in a row have equal height, and gaps are 16px.
- [ ] Picking a branch (top control or table row) changes every figure; picking it again in the table returns to All branches.
- [ ] 7, 14 and 30 days redraw the chart; today's bar is striped; the readout follows hover, focus and tap.
- [ ] No permission keys, metric keys or "Source: …" text appear anywhere.
- [ ] A user without `reports:financial` sees no money values.
- [ ] Light and dark both pass the Studio visual QA matrix (§12 of the design contract).
- [ ] No chart library was added.

## 10. Starter prompt

> Read `docs/design-handoff/pharmacy-dashboard-v2/HANDOFF.md` and follow §0. Implement the owner
> dashboard page content only (§2 to §4), keeping the existing app shell and everything in §6.
> For the daily series, stop and tell me which option from §5 you propose before writing it.
> List the tokens and components you'll reuse and the files you'll change before coding. When
> done, run the §9 checks and attach screenshots at 1440 × 900 in light and dark.
