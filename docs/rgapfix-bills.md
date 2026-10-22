# Restaurant bills gap follow-up — 2026-10-22

## Verification and issue deduplication

The three highest-impact findings rated **High** or **Medium** in
`docs/rgap-restaurant-bills-20261022.md` were re-checked against the current branch before changes.
None was already fixed:

1. **High — refund evidence:** `getBill` selected service-charge and tax refunds, but not
   `deliveryFeeRefundAmount`, `staffProfileId`, `deviceId`, or `coAuthorizationId`; the Finance table
   also omitted all of those values.
2. **High — frozen tax/promotion evidence:** `getBill` selected no tax transaction snapshots, tax
   buckets, tender/refund allocations, or promotion application/evaluation hashes, and the Finance
   detail had no evidence view.
3. **Medium — settlement blockers:** the router already returned authoritative settlement state,
   but no restaurant UI called `getOrderSettlement`, and the Bills register did not submit its
   supported `orderId` filter.

This checkout has no Git remote, GitHub CLI credentials, or locally recorded issue ID for these
three gaps. A public GitHub search for issues in `WhatTheStack1/DevFathom-Hub` returned no project
issue inventory, so no finding could be identified as covered by an open issue. Consequently, none
was skipped. This is the same private-issue-inventory limitation recorded by the source report; it
is not a claim that private issues do not exist.

## Changes

- `src/server/routers/restaurant-bills.ts:174-244` — select delivery-fee refund and refund
  attribution/authorization fields, plus immutable tax snapshots, rate buckets, original-tender
  allocations, and refund allocations.
- `src/server/routers/restaurant-bills.ts:249-278` — load bill promotion applications with frozen
  rule, revision, input, and output hashes without consulting live promotion configuration.
- `src/server/routers/restaurant-bills.ts:317-363` — serialize every returned Decimal/BigInt money
  or allocation value as an exact string.
- `src/components/restaurant/money/money-console.tsx:316-339` — apply the Bills-only order filter
  and consume `getOrderSettlement` only while the Bills tab, branch, and non-empty order ID enable it.
- `src/components/restaurant/money/money-console.tsx:823-835` — add the order filter control to the
  bill register.
- `src/components/restaurant/money/money-console.tsx:1061-1272` — show component refunds and their
  operator/device/manager attribution, settlement blockers and remaining due, and frozen
  tax/promotion evidence in bounded responsive tables.
- `src/server/routers/restaurant-bills.test.ts:15-348` and
  `src/components/restaurant/money/money-console.test.tsx:6-509` — add behavioral fixtures and
  assertions for exact serialization, evidence projection, refund attribution, order filtering,
  and settlement rendering (no source-text assertions).

## Scope notes

The change is additive and read-only. Existing `money:read` capability gating and branch-scope
checks remain on all three procedures; no mutation or ABAC implementation changed. No schema or
migration was required.
