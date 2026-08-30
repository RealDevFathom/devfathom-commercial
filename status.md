# DevFathom delivery status

Last verified: 2026-08-30 (Asia/Karachi)

## Release candidate

- Latest verified code SHA (before this status-only update):
  `86001b20a1a33d877932448b95980f591a90cc4c`
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

### Active release work

- `WHA-913`: production-browser rerun for Dashboard reset/save, real HTTP-503 recovery,
  empty/stale states, permissions, keyboard, and accessibility.
- `WHA-914`: correct Reports CSV prefetch 400s and the Inventory Next `PageProps`
  production-build failure, then repeat Reports browser/export acceptance.
- `WHA-916`: implement Restaurant-specific first-branch setup and durable
  tax/payment/device/operator activation acknowledgements without selecting vendors.

### Required before Restaurant can be called complete

1. Integrate the approved `WHA-914` and `WHA-916` candidates.
2. Pass one standard Node production build from the exact final private SHA.
3. Pass the governed six-test Restaurant E2E once, with no retries, against a fresh
   restricted-role PostgreSQL database; prove migration/RLS/extension non-vacuity and teardown.
4. Record the exact final SHA and browser evidence here.

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
