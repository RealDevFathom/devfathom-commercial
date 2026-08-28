# Tax PRD

## Problem

Restaurant settlement needs a jurisdiction-neutral, effective-dated tax foundation that can preserve exactly what was applied to a transaction without hard-coding unverified jurisdiction rates.

## Users and roles

- **Restaurant finance/admin:** intended owner of branch profiles, official-source evidence, preview, approval, and publication. **NOT IMPLEMENTED:** no mounted tenant tax-management router/page currently exposes those operations. Evidence: [`src/lib/restaurant/tax-contracts.ts`](../../src/lib/restaurant/tax-contracts.ts); absence confirmed under [`src/server/routers`](../../src/server/routers) and [`src/app/api/restaurant`](../../src/app/api/restaurant).
- **Restaurant operator:** settles orders, but current order/bill tax fields remain zero-valued unless future integration invokes the tax core. Evidence: [`prisma/schema.prisma`](../../prisma/schema.prisma), [`src/lib/restaurant/tax-calculator.ts`](../../src/lib/restaurant/tax-calculator.ts).
- **Platform admin:** is not a substitute tax approver and has no implemented Pakistan-rate authoring workflow. Platform and restaurant-admin authority remain distinct. Evidence: [`src/lib/platform/auth.ts`](../../src/lib/platform/auth.ts), [`src/lib/auth.ts`](../../src/lib/auth.ts).

## Current behaviour

- The neutral calculator selects one half-open effective rule by payment category/time, supports EXCLUSIVE and INCLUSIVE modes, modifiers/discounts, Decimal half-up rounding, and largest-remainder splits while conserving totals. Evidence: [`src/lib/restaurant/tax-calculator.ts`](../../src/lib/restaurant/tax-calculator.ts), [`src/lib/restaurant/tax-calculator.test.ts`](../../src/lib/restaurant/tax-calculator.test.ts) — `calculates exclusive modifiers and discounts while conserving totals`, `extracts inclusive tax with half-up rounding`, and `uses half-open effective boundaries`.
- Draft validation requires bounded rates and keeps rule intervals inside their profile interval. Published profiles/rules require approval metadata; published branch profile periods cannot overlap. Evidence: [`src/lib/restaurant/tax-contracts.ts`](../../src/lib/restaurant/tax-contracts.ts), [`prisma/migrations/20260825150000_restaurant_tax_core/migration.sql`](../../prisma/migrations/20260825150000_restaurant_tax_core/migration.sql), [`prisma/migrations/20260825170000_restaurant_tax_core_invariants/migration.sql`](../../prisma/migrations/20260825170000_restaurant_tax_core_invariants/migration.sql), [`tests/restaurant-tax-core-rls.test.ts`](../../tests/restaurant-tax-core-rls.test.ts) — `uses a database exclusion constraint across two concurrent connections`.
- Transaction and rate-bucket snapshots preserve profile/rule, category/mode/rate, and money totals. Database triggers make published/source/snapshot records immutable and permit only one exact full reversal. Every tax table has forced RLS and composite tenant relations. Evidence: [`prisma/schema.prisma`](../../prisma/schema.prisma), [`tests/restaurant-tax-core-rls.test.ts`](../../tests/restaurant-tax-core-rls.test.ts) — `rejects cross-tenant writes and published/source mutation`, `has forced RLS on every tax table`, and `accepts one exact full reversal and rejects positive, over-value, duplicate, and cross-tenant reversals`.
- **NOT IMPLEMENTED — Pakistan profile:** the repository contains no approved/published Pakistan authority sources, rates, category mapping, effective dates, or activation seed. `PKR` in the currency enum is not a Pakistan tax profile. The migration explicitly contains no jurisdiction rates or activation data. Evidence: [`prisma/migrations/20260825150000_restaurant_tax_core/migration.sql`](../../prisma/migrations/20260825150000_restaurant_tax_core/migration.sql), [`prisma/schema.prisma`](../../prisma/schema.prisma).

## Data model

`RestaurantTaxOfficialSource`, `RestaurantTaxProfileVersion`, `RestaurantTaxRuleVersion`, `RestaurantTaxTransactionSnapshot`, and `RestaurantTaxRateBucketSnapshot` are canonical. Profiles are branch/effective-period versioned; rules cite an official source; snapshots and reversal links are append-only evidence. Evidence: [`prisma/schema.prisma`](../../prisma/schema.prisma).

## API surface

- Library-only contracts today: `taxProfileDraftSchema`, `taxPreviewSchema`, `validateTaxProfileDraft`, `resolveTaxRule`, `calculateTax`, and `splitMoney`. Evidence: [`src/lib/restaurant/tax-contracts.ts`](../../src/lib/restaurant/tax-contracts.ts), [`src/lib/restaurant/tax-calculator.ts`](../../src/lib/restaurant/tax-calculator.ts).
- **NOT IMPLEMENTED:** mounted REST/tRPC CRUD, approval/publication, preview, or snapshot-writing API for tax.

## Edge cases and failure modes

- No matching rule, more than one matching rule, rate outside `[0,1]`, invalid period, overlapping published profiles, cross-tenant references, mutation of immutable evidence, duplicate/partial/positive reversal, and rounding imbalance fail explicitly or are prevented by the database. Evidence: [`src/lib/restaurant/tax-calculator.ts`](../../src/lib/restaurant/tax-calculator.ts), [`src/lib/restaurant/tax-calculator.test.ts`](../../src/lib/restaurant/tax-calculator.test.ts) — `rejects a draft rate above one`; [`tests/restaurant-tax-core-rls.test.ts`](../../tests/restaurant-tax-core-rls.test.ts).

## Gaps

- **NOT IMPLEMENTED:** Pakistan federal/provincial profiles, verified source ingestion, effective activation, exemptions, filing/invoice reporting, or regulatory certification.
- **NOT IMPLEMENTED:** integration of profile resolution/calculation/snapshot creation into order pricing, billing, tender, refund, and close flows; existing transactional tax columns default to zero. Evidence: [`prisma/schema.prisma`](../../prisma/schema.prisma), [`src/lib/restaurant/order-pricing.ts`](../../src/lib/restaurant/order-pricing.ts).
- **NOT IMPLEMENTED:** restaurant-admin tax UI/API and approval workflow.
