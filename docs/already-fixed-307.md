# GitHub issue #307: already fixed

Issue #307 reported that the default, neutral `StatusPill` used `#7a7d73` text on
`#efe3d2`, producing 3.31:1 contrast at its 10px text size. The current code no longer
renders that color pair:

- `src/components/ui/status-pill.tsx:15` styles the neutral variant with the semantic
  `bg-muted` and `text-text-muted` utilities. `src/components/ui/status-pill.tsx:19`
  continues to make that neutral variant the default.
- `src/app/globals.css:932` defines the current light-theme `--text-muted` value as
  `#6c6c68`, while `src/app/globals.css:958` defines `--muted` as `#f1f1ee`. These
  declarations occur later in the stylesheet than the legacy palette aliases and
  therefore are the effective values. Their contrast ratio is 4.66:1, satisfying the
  WCAG AA 4.5:1 requirement for normal text.
- `src/app/globals.css:1005` and `src/app/globals.css:1026-1027` provide the dark-theme
  equivalents: `#aaa9a3` text on `#30302d`, with a 5.62:1 contrast ratio.
- `docs/design-system/DEVFATHOM-STUDIO.md:75-86` records the contrast-checked token
  contract and explicitly lists the light-theme muted text token's 4.66:1 worst-case
  ratio.

No runtime code change is required. This conclusion is based on the final declarations
in the CSS cascade rather than the superseded legacy aliases near the beginning of
`globals.css` that were cited by the original finding.
