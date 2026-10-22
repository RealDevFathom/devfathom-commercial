# Already fixed: Pharmacy Administrator report bootstrap requests returned 403

## Verdict

The issue observed at `integration/consolidation-20261019` no longer reproduces from the code on
main (`16a2a370`). No product-code change is required.

## Code evidence

- `src/server/routers/pharmacy-reports.ts:44` gates the pharmacy reports router with the exact
  `reports:operational` capability. The three reported bootstrap procedures all use that gated
  procedure: `branches` at `src/server/routers/pharmacy-reports.ts:322`, `catalog` at
  `src/server/routers/pharmacy-reports.ts:402`, and `getPreferences` at
  `src/server/routers/pharmacy-reports.ts:628`.
- `scripts/seed-pharmacy-e2e.ts:36-44` now includes `reports:operational` (and
  `reports:financial`) in `PHARMACY_E2E_ADMIN_CAPABILITIES`.
- `scripts/seed-pharmacy-e2e.ts:191-220` identifies the swept actor's organization role as
  `administrator` and upserts every capability in that list as an `ALLOW` permission. Therefore
  the Pharmacy Administrator now satisfies the common gate before any of the three procedures
  execute.
- Git blame attributes the report grants in the administrator capability list to `8e7855a`
  (`fix(authz): sensitive pharmacy actions need an exact grant; e2e admin gets explicit grants`),
  which is an ancestor of the requested main revision and postdates the integration snapshot
  named in the report.

## Verification scope

This conclusion is based on static inspection as requested. Tests were not run because the task
explicitly identifies the environment as unsuitable (old Bun, no database, and npm 403) and says
not to run tests or install dependencies.
