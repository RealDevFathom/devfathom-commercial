# PR 174 review notes

## Scope reviewed

Reviewed the substitute proposal and sale-line authorization changes against the integrated mainline parent available in this checkout. The configured checkout has no `origin` remote, so the requested fetch could not be completed.

## Findings fixed

- Reused the counter receipt authorization boundary for substitute proposal listing, price overrides, and substituted sale lines. This keeps tenant, active-member, active-branch, branch-assignment, module, and organization-admin exception behavior aligned.
- Made pharmacy counter capability checks exact-grant-only. Broad `*`, `pharmacy:*`, and similar wildcard grants no longer grant this sensitive access.
- Made any applicable exact or broader pharmacy `DENY` win over an exact `ALLOW`, including when the rules come from different role/override sources.
- Runs substituted sale-line authorization against the transaction-scoped database client so access and the write use the same transactional context.
- Tightened the sale-time binding: the resulting line must retain the authorized canonical quantity, allocate at least one stock part, and allocate every part from the selected proposal lot.
- Added safe-integer and non-negative checks around reference and supplied money totals before comparing or auditing them.
- Added regression coverage for exact counter grants, wildcard rejection, DENY-over-ALLOW, empty/changed allocations, changed canonical quantity, and unsafe money multiplication.

## Review result

No dependency installation or test command was run, as requested. `error.log` is not part of the changes.
