# Fix #632 — pharmacy GRN purchase-order identity validation

## Code evidence

- `src/server/routers/pharmacy-purchasing.ts:989-998` loads each referenced purchase-order
  line's `medicineId` and `packLevelId` alongside its ID, through the existing tenant-scoped
  database client.
- `src/server/routers/pharmacy-purchasing.ts:1002-1020` checks every receipt line before any
  receipt is created. A referenced line must belong to the selected purchase order and its
  medicine and pack must both exactly match the client-supplied receipt identity.
- `src/server/routers/pharmacy-purchasing.ts:1022-1027` performs quantity derivation only after
  that identity check, so mismatched goods cannot proceed to costing, persistence, or posting.
- `src/server/routers/pharmacy-purchasing.test.ts:600-605` models the ordered medicine and pack
  in the focused router fixture.
- `src/server/routers/pharmacy-purchasing.test.ts:720-748` covers a line from another order and
  independent medicine and pack mismatches, asserting that each is forbidden and no goods
  receipt is persisted.

## Scope and invariants

The change is confined to draft-GRN validation. It retains the existing scoped database access,
branch validation, central authorization guard, saleability and pack checks, error mapping,
quantity/cost calculations, and downstream posting behavior. It adds no migration and does not
touch WhatsApp delivery, logging, stock mutation, or idempotency paths.

## Skipped checks

- Dependency installation was not attempted because the task specifies Bun 1.2.14 and reports
  npm registry responses as HTTP 403.
- Automated tests, type checking, linting, and database checks were not run, per the explicit
  code-only/no-tests/no-database instruction. The focused regression tests were added by reasoning
  from the existing Vitest fixture and router flow.
- `git fetch origin main && git merge --no-edit origin/main` was attempted first, but this checkout
  has no `origin` remote. The checked-out HEAD was already the requested base commit `08a247c1`.
