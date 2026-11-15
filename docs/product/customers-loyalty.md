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

## Pharmacy earning and balance migration (DEV-746)

Pharmacy redemption remains **1 point = PKR 1**. `/pharmacy/settings/loyalty`
requires the existing owner/admin capability and Pharmacy CRM entitlement. There is
no default earning rate. Owners explicitly choose a preset (1%, 2%, or 1 point per
PKR 1,000), a custom percentage, or custom points per complete spend step. Rules
are immutable organization-scoped versions; future earning records the version.
All products qualify. Cash and other collected tenders earn at sale settlement;
redeemed points do not generate new points. Exact integer arithmetic rounds down
to whole points per sale or individual collection allocation.

The owner’s Khata switch controls earning on **collection**, including partial
payments. In Pharmacy Finance, post a customer receipt and choose its Khata
account. The existing journal records the receipt and the family ledger allocates
it against outstanding charges in the same transaction. Unallocated receipts
cannot identify a loyalty customer and do not earn. Refund debt cancellations
are not collections. Latest loyalty consent is checked under the customer consent
lock at earning time. Credit on a legacy sale which already earned at sale time
never earns again on collection. Receipt reversal restores the debt and reverses
only the remaining earned points from that receipt.

The schema migration does not activate a program, move balances, or seed a rate.
Before first activation, the owner reviews current branch totals and explicitly
approves reconciliation. A digest rejects stale approvals. The transaction
records the actor, source count, signed total, and per-customer/per-branch totals,
then creates an organization wallet projection exactly once. All original ledger
rows, branch references, and historical refund curves remain unchanged. Existing
ledger RLS policies remain intact. Subsequent entries update the projection in the
same database transaction. Wallets are organization-scoped even when the posting
transaction is branch-scoped; history still identifies the original branch.
Before reconciliation, existing redemption continues against branch-local balances.

New refunds use the earning entry’s immutable version and original payment basis,
not the currently selected rate. Credit refunds first reduce unpaid eligibility;
only refunded collected spend reverses earned points. Consent withdrawal prevents
new earnings, but does not prevent accounting reversals.

The held wallet PR (#64, formerly #603) targets a different integration branch and
is not incorporated or released by DEV-746. #1294’s customer search enhancements
remain separate. The restaurant immutable-version design is reused conceptually;
pharmacy keeps its fixed redemption contract and its own historical ledger.
Production scope and balance reconciliation require authorized operational review;
local source inspection and tests are not evidence of deployed tenant behavior.
