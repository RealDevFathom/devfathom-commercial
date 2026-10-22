# GitHub issue #463 — already fixed

Issue #463 asked whether the single archived `rescue/WHA-98` change, “add customers loyalty
console,” still needed to be recovered. It does not: the current `main` code already contains the
valuable behavior described by that change.

## Current-code evidence

- `src/app/(app)/restaurant/loyalty/page.tsx:3-12` exposes the restaurant **Customers & Loyalty**
  route and renders the existing `LoyaltyConsole` inside the standard page transition.
- `src/components/restaurant/loyalty/loyalty-console.tsx:173-226` entitlement-gates the console and
  loads customer search results, tags, loyalty programs, accounts, selected-customer detail, and
  the selected account's append-only ledger.
- `src/components/restaurant/loyalty/loyalty-console.tsx:253-305` wires the customer tag, consent,
  interaction, privacy export/anonymization, enrollment, program-version, and points-adjustment
  operations into that console.
- `src/components/restaurant/loyalty/loyalty-console.tsx:396-468` provides the Studio page header
  plus explicit module-disabled, permission-denied, loading, and retryable error states. In
  particular, permission denial fails closed instead of displaying cached customer data.
- `src/components/restaurant/loyalty/loyalty-console.tsx:497-582` provides the operational summary
  and the keyboard-accessible customer search and selection registry.
- `src/server/routers/restaurant-loyalty.ts:21-23` keeps reads, configuration, and redemption behind
  their distinct server-side capabilities; `src/server/routers/restaurant-loyalty.ts:81-133`
  applies those procedures to program, account, and ledger reads and loyalty enrollment.
- `src/components/restaurant/loyalty/loyalty-console.test.tsx:370-462` already has focused coverage
  for operational rendering and accessible tables, keyboard selection, loading, empty and error
  states, fail-closed permission denial, and entitlement gating.
- `src/components/restaurant/loyalty/loyalty-console.test.tsx:464-517` also covers destructive
  confirmation, tag assignment, immutable program-version creation, and append-only adjustment
  requests.

## Archive disposition

The archived commit `d706cfae` (`feat(restaurant): add customers loyalty console`) is skipped in
full. Its valuable product outcome is already present on `main`, including server-authorized and
tenant-scoped operations and focused UI tests. Replaying the old console would duplicate or
regress the newer implementation rather than recover missing behavior. There are therefore no
archive changes to port and no migration to add.
