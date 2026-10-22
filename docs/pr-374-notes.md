# PR #374 review notes

## Scope

Reviewed the inventory write-off witness validation change for issue #362 against the branch's
pre-change parent. The requested `origin/main...HEAD` comparison could not be produced because this
checkout has no `origin` remote configured.

## Findings and resolution

- **Resolved:** `writeOff` previously accepted any non-actor string as `witnessId`. It now resolves
  the witness by ID, organization, and `ACTIVE` status before reading or mutating inventory. A
  missing, inactive, or cross-tenant user therefore fails closed with `COAUTH_REQUIRED`.
- **Tenant isolation:** The lookup includes `organizationId` explicitly rather than relying only on
  tenant-scoped database policy. The persisted custody record continues to use the same organization
  and branch as the inventory movement.
- **DENY-over-ALLOW:** An unresolved witness is denied before lot, balance, movement, or custody
  operations. The existing self-witness denial remains in place.
- **Regression coverage:** Tests verify the exact tenant-and-status lookup, the no-write failure
  behavior, and the successful path for an active tenant user.
- **Pharmacy caps and money invariants:** This change does not alter authorization grants, pharmacy
  capability evaluation, or monetary values. No related issue was found within the PR's scope.

## Validation

Per review instructions, dependencies were not installed and tests were not run. The final diff was
reviewed statically, including a whitespace/error scan with `git diff --check`.
