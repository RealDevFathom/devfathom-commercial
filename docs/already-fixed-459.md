# GitHub issue #459: already fixed

## Decision

Close the recovery issue as obsolete. No code from `archive/rescue/WHA-52` should be
re-applied: every valuable behavior named by its four-commit inventory is already present
in the current tree, together with later tenant-boundary and authorization hardening.

The archive ref itself is not available in this checkout: there is no configured `origin`,
and neither `archive/rescue/WHA-52` nor object `9585089c` exists locally. A direct fetch from
the repository named in `RESUME.md` was attempted, but the environment's HTTPS tunnel
rejected it with HTTP 403. Consequently, the verification compared the issue's supplied
commit inventory with the current code rather than manufacturing a branch or claiming a
byte-for-byte Git diff. The skipped list below is therefore a current-code reconciliation,
not a claim that the unavailable archive received a byte-for-byte review.

## Current-code evidence

- The checkout and cash REST surface is present. For example, the tender handler is wired to
  the shared money mutation route, requires `payments:collect`, binds the command to the
  authenticated device branch, and documents device-scoped idempotency
  (`src/app/api/restaurant/checkout/tender/route.ts:1-30`). The complete route set is also
  exercised through the actual HTTP handlers by the database-route battery, including
  revoked-device, replay, capability, and co-authorization cases
  (`src/lib/restaurant/terminal-checkout.db.test.ts:1-21`).
- The cash and payments read surfaces are registered in the application router
  (`src/server/routers/_app.ts:107-110`). Both use the `money:read` capability gate and call
  `requireRestaurantBranchScope` before branch-addressed reads
  (`src/server/routers/restaurant-cash.ts:43-100`,
  `src/server/routers/restaurant-payments.ts:133-189`). This is stronger current behavior
  that must not be replaced by the older archive implementation.
- The ledger pagination fix is present for drawer sessions: input accepts a bounded limit and
  cursor, the query requests `limit + 1`, and cursor continuation skips the boundary row
  (`src/server/routers/restaurant-cash.ts:47-62`,
  `src/server/routers/restaurant-cash.ts:105-123`). Equivalent cursor pagination exists for
  tenders and refunds (`src/server/routers/restaurant-payments.ts:133-169`,
  `src/server/routers/restaurant-payments.ts:194-214`,
  `src/server/routers/restaurant-payments.ts:250-274`).
- Focused tests cover the recovered behavior: cash, tender, and refund tests request the next
  page with the returned cursor, verify its result, and assert that Prisma receives the cursor,
  boundary-row skip, `limit + 1`, and stable compound ordering
  (`src/server/routers/restaurant-cash.test.ts:86-132`,
  `src/server/routers/restaurant-payments.test.ts:89-134`,
  `src/server/routers/restaurant-payments.test.ts:175-224`).

## Archive commit disposition

| Archive commit | Disposition | Reason |
| --- | --- | --- |
| `46114251 feat(m5-l5): checkout & cash REST routes + terminal money glue` | Skipped | The REST handlers, shared money route glue, device-branch binding, capability checks, and idempotency coverage already exist; replaying an older implementation risks regressing later security fixes. |
| `dae19821 test(m5-l5): terminal checkout & cash db-route battery` | Skipped | The current database-route battery drives the real handlers and covers the valuable happy-path and security cases. |
| `a24a26b6 docs(m5-l5): record capability-gate model + register read surface` | Skipped | The current cash/payment routers document their capability and tenant model inline and are registered in the root router. |
| `9585089c fix(restaurant): paginate money ledgers` | Skipped | Drawer sessions, tenders, and refunds already implement bounded cursor pagination, with focused tests. |

No migration is needed, no authorization semantics are changed, and the live WhatsApp send
block is untouched.
