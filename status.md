# DevFathom delivery status

Last verified: 2026-08-30 (Asia/Karachi)

## Release candidate

- Latest verified code SHA (before this status-only update):
  `83132fb4660a6ee0ab74da2ea6eced6ff2ef2b12`
- State: local and unpushed; no shared branch, deployment, or production environment has moved.
- Worktree: clean after the latest integrated verification.

## Restaurant

### Integrated and independently verified

- Restaurant workforce scheduling and timekeeping (`WHA-909`): approved candidate
  `0bffbc72becf753293d3d2a798432a3ad350260a`, privately integrated as `f4c2de70`.
  Focused tests passed 55/55; independent union verification passed 155/155; restricted
  PostgreSQL RLS/concurrency/CAS tests passed 14/14 with zero skips.
- Signed SOP notification webhooks (`WHA-910`): corrected candidate
  `97efa2b083cd370bf3d126c358b3947ec6c60dc8`, privately integrated as `dbbc836e`.
  Focused tests passed 30/30; concurrent retry proof produced one atomic successor.
- Customizable Restaurant dashboard code (`WHA-915`): corrected candidate
  `e51746de495db7d18e54e9e6b037dba3a7ef67f9`, privately integrated as `86001b20`.
  Integrated dashboard tests passed 115/115; lint and 8 GiB TypeScript checks passed.
- Governed Restaurant E2E harness static contract: 15/15 tests passed on the private union.
- Restaurant Reports download and Inventory `PageProps` correction (`WHA-914`): approved
  candidate `8ef4bbfe9c66f3760deb6414fe475a7f929ebd5c`, privately integrated as
  `83132fb4`. Integrated focused tests passed 16/16; changed-file lint and diff checks passed.
  The final composed production build and ordinary-browser CSV network proof remain open.

### Active release work

- `WHA-916`: correct and fully prove Restaurant-specific first-branch setup and durable
  tax/payment/device/operator activation acknowledgements. Candidate `84c3518` is blocked by
  nine command-suite regressions plus missing restricted-PostgreSQL and browser evidence.
- `WHA-917`: fix the remaining Dashboard WCAG contrast failures and unnamed mobile dashboard
  link without changing the accepted dashboard behaviour.
- `WHA-918`: derive Inventory and Purchasing actor/profile/device attribution from the
  authenticated server context instead of trusting mismatched or client-supplied identifiers.
- `WHA-919`: fail closed the incomplete Delivery channel while D06 remains unresolved.
- `WHA-920`: expose the existing device-secret rotation capability safely with one-time reveal,
  old-secret invalidation, authorization, audit, and restricted-role proof.
- `WHA-921`: prevent the simulated camera gateway from being presented as live in production;
  show a professional unavailable state until a real gateway is configured.

### Required before Restaurant can be called complete

1. Integrate independently approved corrections from `WHA-916` through `WHA-921`.
2. Enforce configured Restaurant commercial ceilings and close the accepted ingredient-
   substitution schema seam without colliding with the active identity/onboarding writers.
3. Expand browser acceptance beyond route headings to operate the critical Inventory,
   Purchasing, Workforce, SOP, Loyalty, Device, and Reports workflows.
4. Pass one standard Node production build from the exact final private SHA.
5. Pass the governed six-test Restaurant E2E once, with no retries, against a fresh
   restricted-role PostgreSQL database; prove migration/RLS/extension non-vacuity and teardown.
6. Record the exact final SHA and browser evidence here.

### Product decisions still owned by the product owner

- D03: production card processor/terminal provider. Current card flow must not be represented
  as a live provider integration until one is selected and accepted.
- D05: physical printer/drawer/KDS vendor integration. The product must not invent a vendor.

## SuperAdmin and Agency

- SuperAdmin final browser gate: pending until the Restaurant candidate is frozen; require
  6/6 with zero skips on a fresh isolated database and an owned port.
- Agency final browser gate: pending after SuperAdmin; static harness currently passes 29/29;
  final acceptance requires 8/8 with zero skips on a fresh isolated database.

## Historical ledger

The detailed earlier delivery record remains in
[claude/devfathom-status.md](claude/devfathom-status.md). This file is the current release gate;
historical task completion does not override the live evidence above.
