# PR #375 review notes

## Scope reviewed

- Compared the branch commit with its available local base (`HEAD^`). The checkout has no
  `origin` remote or `origin/main` reference, so the requested fetch and three-dot comparison
  could not be performed in this environment.
- Reviewed the stock-count approval path and its database-backed concurrency regression test.
- Checked the changed path for tenant and branch isolation, authorization-policy interactions,
  exact-grant pharmacy-cap implications, and money invariants.

## Findings and resolutions

1. **Double application under concurrent approval — fixed.** Approval now locks the inventory
   count lifecycle row before reading its status. The lock lookup includes count, organization,
   and branch identifiers, preserving tenant and branch isolation. A second transaction therefore
   reads `APPROVED` only after the first transaction commits and returns the existing
   `INVALID_STATE` domain error without writing another adjustment.
2. **Regression-test overlap proof — strengthened.** The database test holds the first approval's
   transaction open, starts a second approval with a distinct idempotency prefix, and now verifies
   that the second operation remained blocked for the overlap window. It also checks the concrete
   domain-error type and reason, then verifies one adjustment and the single expected balance.
3. **Authorization and tenant isolation — no additional change required.** The patch does not
   alter grants or permission resolution, so DENY-over-ALLOW and exact-grant-only pharmacy caps
   remain unchanged. The new raw lock query has explicit organization and branch predicates and
   continues to execute inside the existing tenant-scoped transaction/RLS context.
4. **Money invariants — not applicable to this narrow change.** Count approval writes stock-unit
   variances only; it does not accept, calculate, or persist monetary values.

## Validation constraints

Per the task instruction, dependencies were not installed and tests were not run. Static review
included inspection of the transaction wrapper, Prisma count schema, migration constraints/RLS,
router transaction boundary, and the final diff. `error.log` is not included.
