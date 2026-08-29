# Tax PRD

## Problem

Restaurants need a jurisdiction-neutral tax core that selects effective-dated rules and freezes the applied calculation for audit, while allowing a Pakistan configuration without hard-coding Pakistan into the engine. Core contracts are `src/lib/restaurant/tax-contracts.ts`; schema is in `prisma/schema.prisma`.

## Users and roles

- Restaurant-admins configure branch tax profiles/rules with approval/source evidence; checkout operators consume the effective result without editing it. Tax core records and lifecycle constraints are defined in `prisma/schema.prisma`.
- Platform-admins govern organization/module availability but do not edit tenant transaction snapshots; platform authorization is `src/lib/platform/auth.ts`, while tenant isolation is verified by `tax core real-PostgreSQL RLS and immutability` in `tests/restaurant-tax-core-rls.test.ts`.

## Current behaviour

- The engine is jurisdiction-neutral: rules carry official source, payment category, price mode, rate, status, and effective interval rather than a country-specific calculation branch. See `src/lib/restaurant/tax-contracts.ts` and tax models in `prisma/schema.prisma`.
- Published profile/rule versions are effective-dated and protected from overlap/mutation; concurrent overlap protection is verified by `uses a database exclusion constraint across two concurrent connections` in `tests/restaurant-tax-core-rls.test.ts`.
- Checkout calculations produce immutable transaction and per-rate-bucket snapshots, including reversal linkage. See `RestaurantTaxTransactionSnapshot`/`RestaurantTaxRateBucketSnapshot` in `prisma/schema.prisma` and `accepts one exact full reversal and rejects positive, over-value, duplicate, and cross-tenant reversals` in `tests/restaurant-tax-core-rls.test.ts`.
- Exact tax arithmetic is implemented in `src/lib/restaurant/tax-calculator.ts` and covered by `src/lib/restaurant/tax-calculator.test.ts`.

## Data model

Official source, tax profile/version, rule/version, transaction snapshot, and rate-bucket snapshot records are in the tax section of `prisma/schema.prisma`. Tenant RLS and published/source immutability are tested by `rejects cross-tenant writes and published/source mutation` and `has forced RLS on every tax table` in `tests/restaurant-tax-core-rls.test.ts`.

## API surface

Tax calculation contracts and effective interval input validation are in `src/lib/restaurant/tax-contracts.ts`; calculation is in `src/lib/restaurant/tax-calculator.ts`. A restaurant-admin CRUD/publishing router dedicated to tax: **NOT IMPLEMENTED**; the currently registered restaurant routers in `src/server/routers/_app.ts` expose no tax router.

## Edge cases and failure modes

- Overlapping effective profiles/rules are rejected at the database boundary; see `uses a database exclusion constraint across two concurrent connections` in `tests/restaurant-tax-core-rls.test.ts`.
- Cross-tenant profile/rule/snapshot relations and invalid reversal shapes are rejected under the restricted runtime role; see `rejects every crafted cross-tenant tax relation under the restricted role` and the exact reversal test in `tests/restaurant-tax-core-rls.test.ts`.
- Missing effective configuration and unsupported payment-category/rate combinations must fail closed in the caller; a complete checkout integration acceptance test: **NOT IMPLEMENTED**.

## Gaps

- A maintained Pakistan profile (federal/provincial sources, restaurant/service rules, payment-method distinctions, effective dates, approval references, and PKR presentation): **NOT IMPLEMENTED**. `PKR` exists in the currency enum in `prisma/schema.prisma`, but no seeded Pakistan tax profile was found. See the [Pakistan restaurant tax source pack](pakistan-restaurant-tax-source-pack.md) for official-source research, unresolved questions, and the unapproved implementation mapping.
- Tax filing, invoice/fiscal-device certification, authority e-invoicing, and automated legal-rate updates: **NOT IMPLEMENTED**.
