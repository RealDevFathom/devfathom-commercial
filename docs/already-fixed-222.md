# GitHub issue #222 is already fixed

The current code already addresses the dark-theme contrast failure reported for the information
status pill on `/restaurant/settings/branches`, so no implementation change is needed:

- The branch settings console renders its `Primary` marker with the shared `StatusPill` and the
  explicit `info` tone (`src/components/restaurant/restaurant-branches-console.tsx:125-126`).
- The shared `info` variant uses `bg-muted text-foreground`, rather than the tenant-controlled
  primary color (`src/components/ui/status-pill.tsx:6-17`).
- In the dark theme those semantic tokens resolve to `#30302d` and `#f7f7f4`, respectively
  (`src/app/globals.css:997-1027`), providing clearly readable foreground text on the pill surface.
- Focused regression coverage asserts the safe semantic classes and rejects any `bg-primary` or
  `text-primary` dependency (`src/components/ui/status-pill.test.ts:5-12`).

This existing shared-component fix changes no authorization, tenant isolation, pharmacy grant,
WhatsApp sending, persistence, or logging behavior.
