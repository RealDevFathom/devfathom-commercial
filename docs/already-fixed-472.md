# GitHub issue #472: already fixed

Verified against commit `775f6f199de88cb6e2bda9d9b787a9eb426f1e1e` on 2026-10-22.

The reported purchase-order approval race is already fixed in the current code by commit
`4345809ea4022bf32bf8372df0dd482d9cca7afe`:

- `src/server/routers/pharmacy-purchasing.ts:790-799` atomically claims the transition with an
  `updateMany` compare-and-swap constrained by both the order ID and `status: 'SUBMITTED'`. A
  zero-row result becomes a `CONFLICT`, so only one concurrent decision can proceed.
- `src/server/routers/pharmacy-purchasing.ts:801-815` appends the approval/rejection event only
  after that claim succeeds, within the same transaction. A losing decision therefore cannot add
  a second audit event.
- `src/server/routers/pharmacy-purchasing.test.ts:412-433` verifies that the status-qualified
  compare-and-swap occurs before the decision event is recorded.
- `src/server/routers/pharmacy-purchasing.test.ts:435-450` simulates a lost concurrent claim and
  verifies that it returns `CONFLICT` without recording a decision or performing the final update.

No production code or migration is needed for this issue.
