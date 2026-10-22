# PR #387 review notes

## Scope

Reviewed the `fix/qa-356` change set for the invariant that a tenant must retain at least one active administrator. The review stayed within team-member role and status mutations; pharmacy grants/caps and monetary code are not changed by this PR.

## Findings and resolutions

- **Cross-endpoint race:** `adminUpdateMember` used a row lock, but `layOffMember` still performed its last-admin count and update without that lock. Concurrent requests through the two endpoints could each observe the other administrator and remove both. Both paths now use the same ordered active-admin lock and perform the invariant check and write in one transaction.
- **Stale authorization/invariant inputs:** role and status were read before the transaction. All role/status edits now acquire the active-admin lock and re-read the target in the transaction. Layoff authorization is also evaluated against the locked, current role, preserving DENY-over-ALLOW behavior if a target is concurrently promoted to administrator.
- **Tenant isolation:** department lookup, member reads, active-admin counts, and member updates now carry the caller's `organizationId` explicitly in addition to the scoped database boundary. The raw lock remains parameterized and tenant-qualified.
- **Lock ordering:** active administrator rows are locked in deterministic ID order to reduce deadlock risk when requests contend for the same tenant.
- **Missing regression coverage:** added cases for the cross-endpoint race, rejection of a sole-admin removal, inactive-admin handling, deterministic/tenant-scoped lock SQL, and tenant-qualified reads/counts/updates.

## Verification note

Per the PR completion instructions, dependencies were not installed and tests were not run. `git diff --check` was used only as a source-tree whitespace check.
