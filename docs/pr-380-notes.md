# PR #380 review notes

## Scope reviewed

Reviewed the RTL changes for the tenant mobile drawer, pharmacy counter search results, and the
bilingual medication card against the branch base available in this checkout. The requested
`origin/main` fetch could not be completed because this checkout has no configured Git remote;
the existing PR commit and its parent were therefore used as the review boundary.

## Findings and resolutions

- **Mobile drawer positioning was only partially logical.** The shell wrapper moved to
  `inset-inline-start`, but the nested `Sidebar` remained fixed to the physical left edge and kept
  a physical right divider. The sidebar now uses `start-0` and `border-e`, with a component-level
  regression test covering the element that actually supplies the fixed positioning.
- **Urdu search names still inherited physical left alignment.** `dir="auto"` selected the bidi
  direction but the row's `text-left` remained inherited, and the strength used a physical left
  margin. The name now uses logical start alignment and the strength uses logical inline-start
  spacing; the regression test covers all three bidi hooks.
- **The medication-card logical divider was resolved in the wrong direction context.** Putting
  `border-s` and `ps-6` directly on a `dir="rtl"` section makes those utilities resolve against the
  Urdu content direction rather than the surrounding two-column layout. The layout border and
  padding now live on an outer direction-neutral grid item, while the nested semantic section
  retains `lang="ur"` and `dir="rtl"`. This keeps the divider between columns in both LTR and RTL
  page contexts.

## Security and invariant review

The reviewed changes are presentation-only and do not alter server authorization, tenant lookup,
pharmacy capability evaluation, or monetary calculations. No tenant-isolation, DENY-over-ALLOW,
exact-grant-only pharmacy-capability, or money-invariant changes were required within this PR's
scope.

## Validation

Per the task instruction, dependencies were not installed and tests were not run. Regression tests
were updated or added for each corrected RTL behavior. No screenshot was captured because the task
explicitly restricted execution to code changes and prohibited running the application.
