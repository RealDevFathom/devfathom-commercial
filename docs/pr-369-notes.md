# PR #369 review notes

## Scope reviewed

- Compared the available branch commits with their local pre-PR base (`9194795`). The checkout has
  no `origin` remote, so `git fetch origin main` and the requested remote comparison could not be
  completed in this environment.
- Reviewed the FEFO override router fixture updates, pharmacy E2E seed permissions, and vertical
  command fixtures introduced by this branch.
- Reviewed the adjacent counter authorization path for tenant scoping, DENY-over-ALLOW behavior,
  exact pharmacy capability grants, and the affected sale write paths.
- Reviewed the touched paths for money arithmetic changes. This PR does not change tender values,
  currency handling, rounding, or other money invariants.

## Findings and resolutions

1. The pharmacy E2E cashier used the non-canonical `pharmacy.counter` capability. The branch now
   seeds the catalog's canonical `pharmacy:counter` grant.
2. The FEFO override tests predated the counter authorization added by PR #319. Their fixture now
   supplies an active, same-organization member with the canonical counter grant and an active
   pharmacy branch assignment, allowing the tests to reach the FEFO behavior they exercise.
3. Counter authorization accepted the canonical counter capability in production, but the focused
   authorization suite did not lock that contract down. The suite now covers the exact
   `pharmacy:counter` grant and proves that an exact user DENY defeats an exact role ALLOW before
   branch assignment or receipt reads occur.
4. Organization creation now reads `defaultSeats` from compatible package records. The successful
   vertical command fixtures now include that required field; validation and incompatibility
   fixtures that return before seat derivation remain intentionally minimal.

## Security review outcome

- Tenant isolation remains enforced by session-organization equality, organization-scoped branch
  lookup, organization-scoped assignments, and active membership checks before counter operations.
- DENY-over-ALLOW remains fail-closed for counter capabilities, including the canonical cashier
  grant added here.
- Unrelated pharmacy capabilities (for example `pharmacy:orders`) remain insufficient for counter
  access; the focused suite already covers this exact-grant boundary.
- No money-bearing implementation changed, so the integer-minor-unit and currency invariants are
  unaffected.

## Validation constraint

Per the task instruction, dependencies were not installed and tests were not run. Static review was
limited to Git diff inspection and whitespace/error checks.
