# Fix #609: mixed-lot pharmacy sale pricing

## Code evidence

- `src/lib/pharmacy/sales.ts:244-302` validates the quantity and allocation shape, checks every allocated lot price against that lot's pro-rata MRP ceiling, and computes the exact allocation-weighted gross. It retains the highest lot price only as the sale line's display price and returns the difference as a non-discretionary MRP adjustment.
- `src/lib/pharmacy/sales.ts:365-397` uses the actual FEFO/reserved allocation and the tenant-and-branch-scoped lot query to build the per-lot pricing inputs.
- `src/lib/pharmacy/sales.ts:398-426` applies margin rules to the exact mixed-lot gross, keeps a customer discount distinct while validating it, and persists the MRP adjustment in the existing `unitPriceMinor * quantity - discountMinor` representation. Thus lots priced at 100 and 101 for one unit each have a net line total of 201, not 202.
- `src/lib/pharmacy/sales.test.ts:159-209` covers the reported 100/101 MRP regression, allocations that split a larger sale unit, short allocations, and a price above its own lot ceiling.
- `src/lib/pharmacy/reserved-sale.test.ts:188-217` exercises the persistence path and verifies that a three-unit reserved mixed-lot sale stores a net total of 301 rather than 303.

## Preserved safeguards

- The pricing change is inside the existing sale-line operation, after scoped sale/medicine/allocation checks, and does not add a mutation or bypass the router's central authorization checks.
- Existing allocation idempotency keys, stock movements, money guardrails, Rx sale gating, tender-time batch safety checks, exact-grant rules, and DENY-over-ALLOW behavior remain unchanged.
- No migration is needed because the existing sale-line price and discount fields can represent the exact net total. No WhatsApp behavior or logging was changed.

## Verification intentionally skipped

- Dependency installation was not attempted because this task specifies Bun 1.2.14 with npm returning 403.
- Automated tests, typechecking, builds, and database checks were not run because the task explicitly requests code-only reasoning with no tests and no database.
- `git fetch origin main && git merge --no-edit origin/main` was attempted first, but this checkout has no `origin` remote. The locally available requested base commit `08a247c1` was merged with `git merge --no-edit 08a247c1`; the merge completed without conflicts and retained all mainline launch fixes and migrations.
