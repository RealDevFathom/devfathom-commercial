# PR #382 review notes

## Findings and fixes

- The original change combined `pharmacy:manage` and `reports:operational` with a simple OR. That
  allowed an explicit `pharmacy:manage` DENY to be bypassed by the reports capability. The bootstrap
  read guard now resolves the exact pharmacy rule first and treats that decision as authoritative.
- Pharmacy administration is intentionally an exact-grant capability. Broad `*` and `pharmacy:*`
  grants therefore do not confer pharmacy-administrator access to these endpoints. Existing callers
  with no exact pharmacy rule may still use the pre-existing `reports:operational` authorization.
- Permission data is read through the request's tenant-scoped database and only for the authenticated
  actor. The existing report scope continues to constrain branch reads to the entitled organization.
- Added regression coverage for exact role grants, user DENY precedence, rejection of wildcard
  pharmacy grants, the legacy operational-reports path, and all three administrator bootstrap reads.

## Scope review

- No report calculations or money handling changed; existing exact/minor-unit money invariants are
  unaffected.
- No dependencies were installed and, as requested, no tests were run.
