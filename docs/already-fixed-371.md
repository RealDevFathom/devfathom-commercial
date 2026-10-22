# GitHub issue #371: already fixed

## Verdict

The reported Pharmacy Administrator 403s are already fixed in the current code. The page-sweep
administrator is granted the same `reports:operational` capability required by all three reported
`pharmacyReports` bootstrap queries, so no product-code change is needed.

## File-and-line evidence

- `src/server/routers/pharmacy-reports.ts:44` defines the shared reports procedure with the
  `reports:operational` capability gate.
- `src/server/routers/pharmacy-reports.ts:322`, `:402`, and `:628` define `branches`, `catalog`, and
  `getPreferences`, respectively, on that shared reports procedure.
- `scripts/seed-pharmacy-e2e.ts:36-44` includes `reports:operational` in the explicit Pharmacy
  Administrator capability list used by the page-sweep fixture.
- `scripts/seed-pharmacy-e2e.ts:191-220` creates or updates the fixture's `administrator` role and
  upserts every capability in that list as `ALLOW`.
- `scripts/seed-pharmacy-e2e.ts:204-208` documents that the fixture intentionally omits the
  exact-grant-only `pharmacy:dispense`, `pharmacy:safety`, and `pharmacy:catalogue-review`
  capabilities. The existing fix therefore does not broaden those sensitive permissions.
- `src/server/routers/pharmacy-reports.ts:115-124` scopes branch reads to the entitled
  organization and active branches, preserving tenant isolation after authorization succeeds.

## Verification scope

This verdict is based on static code inspection. Per the issue instructions, dependencies were not
installed and tests were not run in the Bun 1.2.14, no-database, npm-403 environment.
