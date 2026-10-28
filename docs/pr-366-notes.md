# PR #366 review notes

## Scope reviewed

Reviewed the pharmacy sale-completion changes for issue #340, including the command-layer
completion seam, router wiring, receipt/finance database fixtures, and unit coverage.

## Findings and fixes

- **Completion race (fixed):** the original coverage check read sale lines and tenders before the
  conditional status update acquired the sale-row lock. A concurrent add-line transaction could
  therefore increase the sale total after the check and still allow completion. Completion now
  re-reads and verifies the persisted money facts after the conditional update has acquired the
  lock; a failed check rolls the transaction back.
- **Money invariant (fixed):** coverage previously accepted `tenders >= total`. The normal tender
  path permits only exact settlement, so the direct transition seam now applies the same invariant:
  positive sale value and exact tender equality. It also fails closed for non-integer, unsafe,
  overflowing, negative-net, or non-positive tender data.
- **Duplicate router check (removed):** the router performed a second, earlier coverage query. It
  did not provide concurrency safety and could drift from the command-layer invariant. The guarded
  command is now the single enforcement point, while the router retains scoped branch resolution
  and typed error mapping.
- **Tenant isolation (verified):** sale reads and the conditional transition continue to constrain
  `id`, `organizationId`, and `branchId`; receipt updates retain the organization-qualified compound
  key. No unscoped payment lookup was introduced.
- **Receipt issuance (verified):** insufficient, excessive, malformed, or racing payment state is
  rejected before receipt-number allocation.
- **Regression coverage (added):** unit cases cover underpayment, overpayment, unsafe arithmetic,
  and a changed post-lock snapshot. Existing database fixtures were updated by the branch to create
  exact persisted tenders before exercising legacy completion.

## Review constraints

Per the task request, dependencies were not installed and tests were not run. The requested
`git fetch origin main` could not complete because this checkout has no `origin` remote; review used
the branch commit's parent as the available base.
