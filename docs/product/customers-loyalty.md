# Customers & loyalty PRD

Operator workflow: [Restaurant administrator guide](restaurant-administrator-guide.md#10-customers-and-loyalty).

## Problem

Restaurants need tenant-safe customer profiles and a replay-safe loyalty ledger that earns and redeems points while preserving an auditable liability balance. Customer and loyalty entities are defined in `prisma/schema.prisma`; core behavior is in `src/lib/restaurant/customers.ts` and `src/lib/restaurant/loyalty.ts`.

## Users and roles

- Cashiers/servers search and attach customers at checkout and redeem within their permissions; restaurant-admins configure programs and inspect loyalty. The redeem authorization is tested by `src/server/routers/restaurant-loyalty.test.ts`.
- A platform-admin sets commercial entitlements and limits but does not edit restaurant customer records; platform and restaurant authorization remain separate in `src/lib/platform/auth.ts` and `src/server/routers/restaurant-customers.ts`.

## Current behaviour

- Customer identifiers are organization-scoped and consent/tag/interaction records are modeled separately in `prisma/schema.prisma`.
- Loyalty program changes append immutable versions; account enrollment respects `loyalty.activeCustomers.max`. See `configures by appending the next immutable version` and `denies the N+1 enrollment at loyalty.activeCustomers.max` in `src/lib/restaurant/loyalty.test.ts`.
- Accrual floors the eligible net bill total × rate and happens once; redemption uses Decimal arithmetic and updates discount/grand total atomically. See `earns floor(bill grand total × rate) once for an active linked account`, `earns on the net when the refund preceded the close`, and `redeems with Decimal math and updates discount/grand total atomically` in `src/lib/restaurant/loyalty.test.ts`.
- Balance/liability is the exact signed sum of append-only whole-point ledger entries; see `derives balance as the exact signed whole-points sum` in `src/lib/restaurant/loyalty.test.ts`. Insight rollups are materialized separately in `prisma/schema.prisma` and `src/lib/restaurant/insight-rollups.ts`.

## Data model

`CustomerIdentifier`, interaction/tag/consent models, `LoyaltyProgramVersion`, `LoyaltyAccount`, and `LoyaltyPointsEntry` are in `prisma/schema.prisma`. Reversal entries reference original entries and program-version economics remain pinned; see `pins refund reversal to original earn program and caps cumulative points` in `src/lib/restaurant/loyalty.test.ts`.

## API surface

Restaurant-admin/customer APIs are in `src/server/routers/restaurant-customers.ts` and `src/server/routers/restaurant-loyalty.ts`. Terminal search/attach uses `src/app/api/restaurant/orders/customer/search/route.ts` and `src/app/api/restaurant/orders/customer/attach/route.ts`; checkout snapshot/redemption uses `src/app/api/restaurant/checkout/loyalty/route.ts`.

## Edge cases and failure modes

- Redemption is capped by both account balance and unpaid bill value, and terminal responses omit customer PII; see `caps redeemable points by the balance when the guest cannot cover the bill` and `returns no guest PII — only the ids the redemption call needs` in `src/lib/restaurant/terminal-loyalty.test.ts`.
- Refund/release replay is idempotent and cumulative fractional rounding is based on prior releases; see `replays its own entries without releasing a second time, and reports no money` and `prices the next point off the points already given back, not from zero` in `src/lib/restaurant/loyalty.test.ts`.
- Lifecycle replay/reconciliation runs through the real register path in `src/lib/restaurant/loyalty-lifecycle.db.test.ts`; refund and redemption reconciliation is also covered by `pins refund reversal to original earn program and caps cumulative points` and `replays its own entries without releasing a second time, and reports no money` in `src/lib/restaurant/loyalty.test.ts`.

## Gaps

- A dedicated accounting export of loyalty liability with expiration/breakage policy: **NOT IMPLEMENTED**; current liability is derivable from `LoyaltyPointsEntry` in `prisma/schema.prisma`.
- Cross-brand household merge and external CRM synchronization: **NOT IMPLEMENTED**.
