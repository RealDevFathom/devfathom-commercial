# Fix #637 follow-up notes

## Security-review evidence

- `src/server/routers/pharmacy-inventory.ts:82` defines the regulatory mutation guard with the
  exact `pharmacy:safety` capability.
- `src/server/routers/pharmacy-inventory.ts:1046-1068` attaches `quarantinePart` to that regulatory
  guard and then executes the stock operation inside the router transaction after deriving tenant,
  actor, and branch scope from the request context.
- `src/server/routers/pharmacy-inventory.test.ts:241-290` calls the real
  `pharmacyInventoryRouter.createCaller()` procedure with an exact `pharmacy:safety` ALLOW and an
  explicit `pharmacy:inventory` DENY. It proves the call reaches the transaction and both
  tenant/branch-pinned, idempotent ledger writes. Reverting the procedure to `inventoryControl`
  would therefore stop the call before those assertions and fail the regression test.

## Skipped by instruction or environment

- Dependency installation and all test commands were skipped as requested (Bun 1.2.14, no
  database, and npm access returns 403).
- `git fetch origin main && git merge --no-edit origin/main` was attempted first as requested, but
  this checkout has no `origin` remote. The checked-out history already has base `08a247c` as its
  direct ancestor, so no substitute merge was performed.
- No migration was needed for this test-only follow-up.
- No browser screenshot was taken because this change has no user-interface effect.
