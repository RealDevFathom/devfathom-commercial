# GitHub issue #470 — already fixed

Verified against the current code on 2026-10-22. The reported authorization gap is already
closed, so no production code or tests were changed.

## Code evidence

- `src/server/routers/pharmacy-inventory.ts:82-83` defines the inventory mutation procedure with
  the exact `pharmacy:inventory` capability.
- `src/server/routers/pharmacy-inventory.ts:150-168` derives the tenant and actor from the session,
  requires an active branch in that tenant, and rejects callers without an active assignment to
  that same active tenant branch.
- `src/server/routers/pharmacy-inventory.ts:618`, `:817`, `:976`, and `:1032` apply the inventory
  mutation procedure to `createLocation`, `receiveLot`, `createCount`, and `writeOff`, respectively.
- Each affected resolver calls the assignment-enforcing scope helper before performing its write:
  `src/server/routers/pharmacy-inventory.ts:655`, `:839`, `:1000`, and `:1050`.
- `src/server/trpc.ts:273-297` denies a capability-protected request when the ABAC decision is not
  allowed, and `src/server/trpc.ts:344-345` composes that check with auditing and module licensing.

## Regression evidence

- `src/server/routers/pharmacy-inventory.test.ts:307-315` covers all four reported mutations and
  expects `FORBIDDEN` when `pharmacy:inventory` is absent.
- `src/server/routers/pharmacy-inventory.test.ts:317-337` covers all four mutations and expects
  `FORBIDDEN` when the actor lacks an active assignment for the requested branch.
- `src/server/routers/pharmacy-inventory.test.ts:339-349` verifies that an explicit
  `pharmacy:inventory` deny overrides a role allow.

The existing fix is present in commit `930a90d` (`fix(#470)`) and is an ancestor of the current
branch.
