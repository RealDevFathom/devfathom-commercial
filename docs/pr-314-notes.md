# PR #314 review notes

## Scope reviewed

Reviewed the PR changes for controlled-drug goods-receipt reversal and the
authorization gates on reversal/exception-resolution operations. The checkout
does not have an `origin` remote, so the requested fetch could not run; the
review used the available integration-side merge parent (`396c34e`) as the
comparison point.

## Findings and fixes

- **Controlled-register restoration:** kept the immutable purchase correction
  emitted for each linked reversal movement and the end-to-end database test
  covering purchase, reversal, and the resulting zero balance.
- **Tenant and branch isolation:** confirmed that reversal lookups carry the
  organization and branch scope, and that the two exposed mutations now require
  an active assignment for the requested branch before any transaction or
  update begins.
- **DENY-over-ALLOW:** tightened procurement evaluation so any matching deny,
  whether attached to the role or an override, wins over an allow.
- **Exact-grant-only pharmacy capability:** wildcard allows (`*`,
  `pharmacy.*`, and `pharmacy:*`) no longer confer regulated procurement
  access. Only the explicitly supported procurement capability spellings can
  allow the action. Added regression coverage for wildcard rejection and a
  role-level wildcard deny overriding an exact direct allow.
- **Database fail-closed behavior:** the replacement reconciliation trigger now
  rejects register rows whose stock movement does not exist. PostgreSQL null
  comparison previously let a missing movement pass the movement-kind checks.
- **Register identity integrity:** the trigger now binds the register's batch,
  medicine, and branch to the referenced inventory lot instead of validating
  only the batch label.
- **Money invariants:** this PR does not introduce or modify monetary values or
  calculations. Receipt reversal remains quantity-ledger compensation and does
  not rewrite original receipt amounts.

## Validation

Per task instructions, dependencies were not installed and tests were not run.
Static review included `git diff --check` and inspection of the complete PR
diff against the available integration parent.
