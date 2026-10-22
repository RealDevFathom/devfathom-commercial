# GitHub issue #307: already fixed

Issue #307 reported that the default, neutral `StatusPill` used `#7a7d73` text on
`#efe3d2`, producing 3.31:1 contrast at its 10px text size. The current code no longer
renders that color pair:

- `src/components/ui/status-pill.tsx:15` styles the neutral variant with `bg-muted`
  and `text-text-strong`; it does not use the lower-contrast `text-text-muted` utility.
  `src/components/ui/status-pill.tsx:19` continues to make that neutral variant the
  default.
- `src/app/globals.css:930` defines the effective light-theme `--text-strong` value as
  `#111110`, while `src/app/globals.css:958` defines `--muted` as `#f1f1ee`. Their
  contrast ratio is 16.70:1, satisfying the WCAG AA 4.5:1 requirement for normal text.
- `src/app/globals.css:1003` and `src/app/globals.css:1026` provide the dark-theme
  equivalents: `#f7f7f4` text on `#30302d`, with a 12.33:1 contrast ratio.
- `docs/design-system/DEVFATHOM-STUDIO.md:75-86` records the contrast-checked token
  contract and explicitly lists the light-theme muted text token's 4.66:1 worst-case
  ratio.

The focused regression coverage in `src/components/ui/status-pill.test.tsx:7-15`
asserts that an unmapped status resolves to the neutral tone, uses `text-text-strong`,
and does not regress to `text-text-muted`. No further runtime change is required.
