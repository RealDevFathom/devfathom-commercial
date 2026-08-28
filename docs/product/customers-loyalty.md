# Customers and loyalty PRD

## Problem

Restaurants need tenant-isolated customer records and an auditable points liability that stays correct through earning, redemption, refunds, expiry, retries, and corrected daily projections.

## Users and roles

- **Restaurant staff/operator:** searches or attaches customers and may redeem where role capabilities allow. Evidence: [`src/lib/restaurant/terminal-customers.ts`](../../src/lib/restaurant/terminal-customers.ts), [`src/lib/restaurant/terminal-loyalty.ts`](../../src/lib/restaurant/terminal-loyalty.ts).
- **Restaurant admin/manager:** manages customer corrections/privacy, program versions, enrollments, adjustments, and insight/backfill procedures under tenant permissions. Evidence: [`src/server/routers/restaurant-customers.ts`](../../src/server/routers/restaurant-customers.ts), [`src/server/routers/restaurant-loyalty.ts`](../../src/server/routers/restaurant-loyalty.ts), [`src/server/routers/restaurant-insights.ts`](../../src/server/routers/restaurant-insights.ts).
- **Platform admin:** controls module/limit entitlements, not ordinary customer PII or restaurant-admin workflows. Evidence: [`src/lib/entitlements.ts`](../../src/lib/entitlements.ts), [`prisma/schema.prisma`](../../prisma/schema.prisma).

## Current behaviour

- Customer identity, tags, interactions, consent, export/anonymization, and one loyalty account per customer are tenant scoped. Customer PII is separate from agency clients. Evidence: [`src/lib/restaurant/customers.ts`](../../src/lib/restaurant/customers.ts), [`src/lib/restaurant/customer-privacy.ts`](../../src/lib/restaurant/customer-privacy.ts), [`prisma/schema.prisma`](../../prisma/schema.prisma).
- Program configuration appends effective-dated immutable versions. Balance is the signed sum of an append-only whole-points ledger. Closing an eligible linked order earns `floor(net amount × rate)` once; pre-close refunds reduce earnable value. Evidence: [`src/lib/restaurant/loyalty.ts`](../../src/lib/restaurant/loyalty.ts), [`src/lib/restaurant/loyalty.test.ts`](../../src/lib/restaurant/loyalty.test.ts) — `configures by appending the next immutable version`, `derives balance as the exact signed whole-points sum`, and `earns on the net when the refund preceded the close`.
- Redemption uses Decimal monetary value and atomically changes the bill discount/grand total plus ledger. Refund reversal remains pinned to the original earn program; release returns only the points needed when a redemption-bearing bill changes. Evidence: [`src/lib/restaurant/loyalty.test.ts`](../../src/lib/restaurant/loyalty.test.ts) — `redeems with Decimal math and updates discount/grand total atomically`, `pins refund reversal to original earn program and caps cumulative points`, and `releases only the whole points the shortfall needs`.
- FIFO expiry consumes remaining earned lots after redemptions/reversals and appends negative entries. Daily branch and organization liability projections derive positive balances at the effective redemption value; rollup replay no-ops at the same close tip and replaces projections after an authoritative correction. Evidence: [`src/lib/restaurant/loyalty-expiry.test.ts`](../../src/lib/restaurant/loyalty-expiry.test.ts) — `expires only remaining earned lots after FIFO redemption and linked reversal`; [`src/lib/restaurant/insight-rollups.test.ts`](../../src/lib/restaurant/insight-rollups.test.ts) — `counts only positive ledger balances at effective redemption value`, `no-ops when current close source was already projected`, and `replaces projection against authoritative correction chain tip`.

## Data model

Canonical records are `RestaurantCustomer`, identifiers/tags/interactions/consents, `LoyaltyProgramVersion`, `LoyaltyAccount`, append-only `LoyaltyPointsEntry`, branch daily insight rollups, and organization loyalty-liability rollups/fingerprints. Evidence: [`prisma/schema.prisma`](../../prisma/schema.prisma), [`tests/restaurant-m8-governance.test.ts`](../../tests/restaurant-m8-governance.test.ts) — `rejects UPDATE and DELETE of an effective loyalty version`.

## API surface

- Tenant tRPC: `restaurantCustomers` list/detail/create/correct/attach/interactions/consent/tags/export/anonymize; `restaurantLoyalty` programs/accounts/ledger/configure/adjust/redeem; `restaurantInsights` operational/financial reports and backfill. Evidence: [`src/server/routers/restaurant-customers.ts`](../../src/server/routers/restaurant-customers.ts), [`src/server/routers/restaurant-loyalty.ts`](../../src/server/routers/restaurant-loyalty.ts), [`src/server/routers/restaurant-insights.ts`](../../src/server/routers/restaurant-insights.ts).
- Terminal REST: customer search/attach and checkout loyalty routes. Evidence: [`src/app/api/restaurant/orders/customer`](../../src/app/api/restaurant/orders/customer), [`src/app/api/restaurant/checkout/loyalty/route.ts`](../../src/app/api/restaurant/checkout/loyalty/route.ts).

## Edge cases and failure modes

- Idempotency keys prevent duplicate enrollment, interaction, consent, points, and liability effects; release replay uses its own key namespace. Evidence: [`src/lib/restaurant/loyalty.test.ts`](../../src/lib/restaurant/loyalty.test.ts) — `enrolls below the bootstrapped cap without duplicating an immediate retry` and `replays its own entries without releasing a second time, and reports no money`.
- Insufficient balance, inactive/missing program, unlinked customer/account, expired entitlement limits, cross-tenant IDs, and raw-fact reconciliation mismatch fail closed. Evidence: [`src/lib/restaurant/loyalty.ts`](../../src/lib/restaurant/loyalty.ts), [`src/lib/restaurant/insight-rollups.test.ts`](../../src/lib/restaurant/insight-rollups.test.ts) — `fails closed when raw facts do not exactly reconcile`.

## Gaps

- **NOT IMPLEMENTED:** transferable points, household/shared accounts, tier/status programs, external loyalty providers, or customer self-service/mobile wallet surfaces.
- **PARTIAL:** operational/financial insight routes and liability rollups exist, but no repository evidence establishes a consolidated executive restaurant dashboard. Evidence: [`src/server/routers/restaurant-insights.ts`](../../src/server/routers/restaurant-insights.ts).
