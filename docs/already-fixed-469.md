# GitHub issue #469: already fixed

Issue #469 reported that four pharmacy procurement mutations were guarded only by
`protectedProcedure`. The current code already closes that authorization gap:

- `assertProcurement` checks the canonical `pharmacy:procurement` capability through `can`, using
  the session subject and tenant-scoped database context, and returns `FORBIDDEN` when the check
  fails (`src/server/routers/pharmacy-purchasing.ts:185-198`).
- `createSupplier` calls the guard before creating a supplier
  (`src/server/routers/pharmacy-purchasing.ts:375-392`).
- `setSupplierAuthorization` calls the guard before looking up or updating a supplier
  (`src/server/routers/pharmacy-purchasing.ts:429-439`).
- `createPurchaseOrder` calls the guard before supplier, requisition, catalogue, or order access
  (`src/server/routers/pharmacy-purchasing.ts:635-726`).
- `approvePurchaseOrder` calls the guard before opening its approval transaction
  (`src/server/routers/pharmacy-purchasing.ts:752-765`).

Focused regression coverage exercises all four procedures as a same-tenant member whose unrelated
grant does not authorize procurement. It asserts the canonical capability check, the `FORBIDDEN`
response, and that no supplier or purchase-order reads or writes occur
(`src/server/routers/pharmacy-purchasing.test.ts:122-175`).

The fix was already present in commit `38be7953d4d0cfd77bf0c50b501027de75354dfd`, which is an
ancestor of the current branch. No production code or tests were changed during this verification.
